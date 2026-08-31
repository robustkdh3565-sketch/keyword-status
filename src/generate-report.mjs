import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterItems, normalizeTitle } from "./lib/topic-normalizer.mjs";
import { compareSnapshots, postKey } from "./lib/snapshot-metrics.mjs";
import { buildExpansionThemes, buildWeeklyTopics } from "./lib/weekly-topics.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputArg = process.argv.find((arg) => arg.endsWith(".json"));
const checkOnly = process.argv.includes("--check");

if (!inputArg) {
  console.error("사용법: npm run report -- data/YYYY-MM-DD.json");
  process.exit(1);
}

const rules = JSON.parse(await readFile(resolve(projectRoot, "config/rules.json"), "utf8"));
const learnedModel = await readFile(resolve(projectRoot, "model/weights.json"), "utf8").then(JSON.parse).catch(() => null);
const inputPath = resolve(projectRoot, inputArg);
const daily = JSON.parse(await readFile(inputPath, "utf8"));
const communityMap = new Map(rules.communities.map((item) => [item.id, item]));

const errors = [];
if (!daily.date || !daily.checkedAt || !Array.isArray(daily.items)) {
  errors.push("date, checkedAt, items 필드가 필요합니다.");
}

const seenCommunities = new Set();
for (const [index, item] of (daily.items ?? []).entries()) {
  if (!communityMap.has(item.community)) errors.push(`${index + 1}번 항목의 community가 올바르지 않습니다.`);
  seenCommunities.add(item.community);
  for (const key of ["title", "url", "publishedAt"]) {
    if (!item[key]) errors.push(`${index + 1}번 항목에 ${key}가 없습니다.`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

if (checkOnly) {
  console.log(`${daily.items.length}개 항목 검증 완료`);
  process.exit(0);
}

const checkedAt = new Date(daily.checkedAt);
const items = clusterItems(daily.items, rules.normalization);
const snapshotDirectory = resolve(projectRoot, "snapshots", daily.date);
const snapshotFiles = await readdir(snapshotDirectory).catch(() => []);
const snapshotHistory = await Promise.all(snapshotFiles
  .filter((name) => name.endsWith(".json"))
  .map((name) => readFile(resolve(snapshotDirectory, name), "utf8").then(JSON.parse).catch(() => null)));
const snapshotComparison = compareSnapshots({ checkedAt: daily.checkedAt, items }, snapshotHistory.filter(Boolean));
const snapshotMetricFor = (item) => snapshotComparison.metrics.get(postKey(item));
const snapshotStatus = snapshotComparison.previous
  ? `${snapshotComparison.previous.checkedAt} 대비 실제 증가량 측정`
  : "첫 스냅샷 또는 이전 측정 없음 · 속도는 게시 후 평균 추정";
const qualityFields = ["views", "comments", "reactions", "rank", "candidateCount", "publishedAt"];
const qualityPresent = items.reduce((sum, item) => sum + qualityFields.filter((field) => item[field] !== undefined && item[field] !== null).length, 0);
const dataQualityScore = items.length ? (qualityPresent / (items.length * qualityFields.length)) * 100 : 0;
const percentile = (value, values) => {
  if (!values.length) return 0;
  if (values.length === 1) return 100;
  const below = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return ((below + Math.max(0, equal - 1) / 2) / (values.length - 1)) * 100;
};
const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const numberOrNull = (value) => hasNumber(value) ? Number(value) : null;
const observedViews = (item) => Number(item.views) === 0 && item.source === "todayBest" && (Number(item.comments ?? 0) > 0 || Number(item.reactions ?? 0) > 0)
  ? null
  : numberOrNull(item.views);
const percentileOrNull = (value, values) => hasNumber(value) ? percentile(Number(value), values) : null;
const averageAvailable = (...values) => {
  const available = values.filter(hasNumber).map(Number);
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
};
const weightedAvailable = (entries) => {
  const available = entries.filter(({ value }) => hasNumber(value));
  const totalWeight = available.reduce((sum, entry) => sum + entry.weight, 0);
  return totalWeight ? available.reduce((sum, entry) => sum + Number(entry.value) * entry.weight, 0) / totalWeight : null;
};
const formatCount = (value, unit) => hasNumber(value) ? `${Number(value).toLocaleString("ko-KR")}${unit}` : "미수집";
const formatVelocity = (value) => hasNumber(value) ? `${Math.round(Number(value)).toLocaleString("ko-KR")}회` : "측정 대기";
const formatScore = (value) => hasNumber(value) ? Number(value).toFixed(0) : "미수집";
const itemMetrics = items.map((item) => ({
  item,
  views: observedViews(item),
  comments: numberOrNull(item.comments),
  reactions: numberOrNull(item.reactions),
  engagement: hasNumber(observedViews(item)) && observedViews(item) > 0 && (hasNumber(item.comments) || hasNumber(item.reactions))
    ? ((Number(item.comments ?? 0) + Number(item.reactions ?? 0)) / observedViews(item)) * 1000
    : null
}));
const viewValues = itemMetrics.map((entry) => entry.views).filter(hasNumber);
const commentValues = itemMetrics.map((entry) => entry.comments).filter(hasNumber);
const reactionValues = itemMetrics.map((entry) => entry.reactions).filter(hasNumber);
const engagementValues = itemMetrics.map((entry) => entry.engagement).filter(hasNumber);
const hourlyViewValues = items.map((item) => {
  const measured = snapshotMetricFor(item);
  if (measured?.measured) return measured.viewsPerHour;
  if (!hasNumber(observedViews(item)) || item.publishedAtSource === "estimated") return null;
  const ageHours = Math.max(0.5, (checkedAt - new Date(item.publishedAt)) / 3_600_000);
  return observedViews(item) / ageHours;
}).filter(hasNumber);
const metricByItem = new Map(itemMetrics.map((entry) => [entry.item, {
  viewScore: percentileOrNull(entry.views, viewValues),
  commentScore: percentileOrNull(entry.comments, commentValues),
  reactionScore: percentileOrNull(entry.reactions, reactionValues),
  engagementScore: percentileOrNull(entry.engagement, engagementValues)
}]));
const groups = new Map();
for (const item of items) {
  const group = groups.get(item.topic) ?? [];
  group.push(item);
  groups.set(item.topic, group);
}

const requiredWeightKeys = ["impact", "viewPerformance", "commentsAndEngagement", "freshness"];
const learnedWeights = learnedModel?.weights;
const weights = learnedWeights && requiredWeightKeys.every((key) => typeof learnedWeights[key] === "number")
  ? learnedWeights
  : rules.scoring.weights;

const topics = [...groups.entries()].map(([topic, items]) => {
  const newestAgeHours = Math.min(...items.map((item) => (checkedAt - new Date(item.publishedAt)) / 3_600_000));
  const communities = [...new Set(items.map((item) => item.community))];
  const communityCount = communities.length;
  const communityGroups = [...new Set(communities.map((id) => rules.communityGroups[id] ?? id))];
  const collectedViews = items.map(observedViews).filter(hasNumber);
  const collectedComments = items.map((item) => numberOrNull(item.comments)).filter(hasNumber);
  const communitySpreadScore = communityCount >= 5 ? 100 : communityCount === 4 ? 90 : communityCount === 3 ? 75 : communityCount === 2 ? 55 : 20;
  const groupSpreadScore = communityGroups.length >= 4 ? 100 : communityGroups.length === 3 ? 80 : communityGroups.length === 2 ? 60 : 20;
  const impactScore = communitySpreadScore * 0.65 + groupSpreadScore * 0.35;
  const featureRows = items.map((item) => {
    const metrics = metricByItem.get(item);
    const ageHours = Math.max(0, (checkedAt - new Date(item.publishedAt)) / 3_600_000);
    const freshnessScore = Math.max(0, Math.min(100, 100 * Math.exp((-Math.log(2) * ageHours) / 12)));
    const hoursElapsed = Math.max(0.5, ageHours);
    const measured = snapshotMetricFor(item);
    const viewsPerHour = measured?.measured
      ? measured.viewsPerHour
      : hasNumber(observedViews(item)) && item.publishedAtSource !== "estimated" ? observedViews(item) / hoursElapsed : null;
    const viewVelocityScore = percentileOrNull(viewsPerHour, hourlyViewValues);
    return { ...metrics, freshnessScore, hoursElapsed, viewsPerHour, viewVelocityScore, velocityMeasured: Boolean(measured?.measured) };
  });
  const maxOf = (key) => {
    const values = featureRows.map((row) => row[key]).filter(hasNumber).map(Number);
    return values.length ? Math.max(...values) : null;
  };
  const commentScore = maxOf("commentScore");
  const engagementScore = maxOf("engagementScore");
  const commentsAndEngagementScore = averageAvailable(commentScore, engagementScore);
  const reactionScore = maxOf("reactionScore");
  const viewScore = maxOf("viewScore");
  const viewVelocityScore = maxOf("viewVelocityScore");
  const viewPerformanceScore = weightedAvailable([{ value: viewVelocityScore, weight: 0.65 }, { value: viewScore, weight: 0.35 }]);
  const freshnessScore = maxOf("freshnessScore");
  const trendScore = weightedAvailable([
    { value: impactScore, weight: weights.impact },
    { value: viewPerformanceScore, weight: weights.viewPerformance },
    { value: commentsAndEngagementScore, weight: weights.commentsAndEngagement },
    { value: freshnessScore, weight: weights.freshness }
  ]);
  const decision = trendScore >= rules.classification.mustProduceScore ? "반드시 제작" : trendScore >= rules.classification.priorityScore ? "제작 우선" : trendScore >= rules.classification.observeScore ? "추가 관찰" : "제외";
  const predictionWeights = rules.prediction.weights;
  const predictionScore = weightedAvailable([
    { value: viewVelocityScore, weight: predictionWeights.viewVelocity },
    { value: commentsAndEngagementScore, weight: predictionWeights.engagement },
    { value: freshnessScore, weight: predictionWeights.freshness },
    { value: impactScore, weight: predictionWeights.impact }
  ]);
  return {
    topic,
    items,
    communities,
    communityGroups,
    newestAgeHours,
    totalComments: collectedComments.length ? collectedComments.reduce((sum, value) => sum + value, 0) : null,
    totalViews: collectedViews.length ? collectedViews.reduce((sum, value) => sum + value, 0) : null,
    needsVerification: items.some((item) => item.needsVerification),
    trendScore,
    predictionScore,
    decision,
    viewsPerHour: maxOf("viewsPerHour"),
    velocityMeasured: featureRows.some((row) => row.velocityMeasured),
    scores: { impactScore, commentsAndEngagementScore, reactionScore, viewScore, viewVelocityScore, viewPerformanceScore, freshnessScore }
  };
});

const major = topics
  .filter((topic) => topic.communities.length >= rules.classification.majorMinCommunities || (topic.communityGroups.length >= 2 && topic.scores.impactScore >= 60))
  .sort((a, b) => b.trendScore - a.trendScore)
  .slice(0, rules.classification.maxTopicsPerSection);

const majorNames = new Set(major.map((topic) => topic.topic));
const rising = topics
  .filter((topic) => !majorNames.has(topic.topic) && topic.newestAgeHours <= rules.classification.risingMaxAgeHours && (topic.communities.length >= 2 || topic.scores.viewPerformanceScore >= 90))
  .sort((a, b) => b.trendScore - a.trendScore)
  .slice(0, rules.classification.maxTopicsPerSection);

const formatTopic = (entry) => {
  const names = entry.communities.map((id) => communityMap.get(id)?.name ?? id).join(" · ");
  const verification = entry.needsVerification ? " · 사실 확인 필요" : "";
  const urls = entry.items.map((item) => `[${communityMap.get(item.community)?.name ?? item.community}](${item.url})`).join(" · ");
  return `- **${entry.topic}** — ${entry.trendScore.toFixed(1)}점 · ${entry.decision} · ${names} · 조회 ${formatCount(entry.totalViews, "회")} · ${entry.velocityMeasured ? "실측" : "추정"} 시간당 ${formatVelocity(entry.viewsPerHour)} · 댓글 ${formatCount(entry.totalComments, "개")}${verification}\n  - 커뮤니티 세부점수: 파급력 ${formatScore(entry.scores.impactScore)} · 조회성과 ${formatScore(entry.scores.viewPerformanceScore)} · 댓글/반응 ${formatScore(entry.scores.commentsAndEngagementScore)} · 최신성 ${formatScore(entry.scores.freshnessScore)}\n  - 원문: ${urls}`;
};

const videoCandidates = topics
  .filter((entry) => entry.trendScore >= rules.classification.videoMinimumScore || entry.totalViews >= rules.classification.videoMinimumTotalViews || (entry.newestAgeHours <= 6 && entry.totalViews >= rules.classification.videoMinimumViewsWithin6Hours))
  .filter((entry) => entry.scores.impactScore >= rules.classification.videoMinimumImpactScore || entry.totalViews >= rules.classification.videoMinimumTotalViews || (entry.newestAgeHours <= 6 && entry.totalViews >= rules.classification.videoMinimumViewsWithin6Hours))
  .sort((a, b) => b.trendScore - a.trendScore)
  .slice(0, 5);

const predictedVideos = topics
  .filter((entry) => entry.newestAgeHours <= rules.classification.predictionMaxAgeHours)
  .filter((entry) => entry.scores.viewPerformanceScore >= rules.classification.predictionMinimumViewPerformance)
  .filter((entry) => entry.predictionScore >= rules.classification.predictionMinimumScore)
  .sort((a, b) => b.predictionScore - a.predictionScore)
  .slice(0, rules.classification.predictionMaxTopics);
const viewsPerHourFor = (item) => {
  const measured = snapshotMetricFor(item);
  if (measured?.measured) return measured.viewsPerHour;
  if (!hasNumber(observedViews(item)) || item.publishedAtSource === "estimated") return null;
  const ageHours = Math.max(0.5, (checkedAt - new Date(item.publishedAt)) / 3_600_000);
  return observedViews(item) / ageHours;
};
const likelyPostByKey = new Map(items.map((item) => {
  const ageHours = Math.max(0, (checkedAt - new Date(item.publishedAt)) / 3_600_000);
  const engagement = hasNumber(observedViews(item)) && observedViews(item) > 0 && (hasNumber(item.comments) || hasNumber(item.reactions))
    ? ((Number(item.comments ?? 0) + Number(item.reactions ?? 0)) / observedViews(item)) * 1000 : null;
  const velocityScore = percentileOrNull(viewsPerHourFor(item), hourlyViewValues);
  const engagementScore = percentileOrNull(engagement, engagementValues);
  const freshnessScore = Math.max(0, Math.min(100, 100 * Math.exp((-Math.log(2) * ageHours) / 12)));
  const spread = new Set((groups.get(item.topic) ?? []).map((candidate) => candidate.community)).size;
  const spreadScore = spread >= 4 ? 100 : spread === 3 ? 80 : spread === 2 ? 60 : 20;
  const score = weightedAvailable([{ value: velocityScore, weight: 0.40 }, { value: engagementScore, weight: 0.30 }, { value: freshnessScore, weight: 0.15 }, { value: spreadScore, weight: 0.15 }]);
  const eligible = hasNumber(score) && hasNumber(velocityScore) && item.publishedAtSource !== "estimated" && ageHours <= 12 && score >= 65 && (velocityScore >= 70 || (hasNumber(observedViews(item)) && observedViews(item) >= 10_000));
  return [postKey(item), eligible ? { score, velocityScore, engagementScore, freshnessScore, spreadScore } : null];
}).filter(([, prediction]) => prediction));
const communitySelections = rules.communities.map((community) => {
  const candidates = items.filter((item) => item.community === community.id);
  if (!candidates.length) return null;
  const candidateViews = candidates.map(observedViews).filter(hasNumber);
  const candidateEngagement = candidates.map((item) => hasNumber(observedViews(item)) && observedViews(item) > 0 && (hasNumber(item.comments) || hasNumber(item.reactions)) ? ((Number(item.comments ?? 0) + Number(item.reactions ?? 0)) / observedViews(item)) * 1000 : null).filter(hasNumber);
  const candidateVelocities = candidates.map(viewsPerHourFor).filter(hasNumber);
  const candidateEngagementDeltas = candidates.map((item) => snapshotMetricFor(item)?.engagementDelta).filter(hasNumber);
  const risingScore = (item) => {
    const snapshot = snapshotMetricFor(item);
    const velocity = viewsPerHourFor(item);
    const ageHours = Math.max(0, (checkedAt - new Date(item.publishedAt)) / 3_600_000);
    const freshnessScore = Math.max(0, Math.min(100, 100 * Math.exp((-Math.log(2) * ageHours) / 12)));
    const rankRiseScore = hasNumber(snapshot?.rankChange) ? Math.max(0, Math.min(100, Number(snapshot.rankChange) * 25)) : null;
    return weightedAvailable([
      { value: percentileOrNull(velocity, hourlyViewValues), weight: 0.40 },
      { value: percentileOrNull(velocity, candidateVelocities), weight: 0.25 },
      { value: percentileOrNull(snapshot?.engagementDelta, candidateEngagementDeltas), weight: 0.15 },
      { value: rankRiseScore, weight: 0.10 },
      { value: freshnessScore, weight: 0.10 }
    ]);
  };
  const majorScore = (item) => {
    const rankScore = ((Number(item.candidateCount || candidates.length) - Number(item.rank || candidates.length) + 1) / Math.max(1, Number(item.candidateCount || candidates.length))) * 100;
    const engagement = hasNumber(observedViews(item)) && observedViews(item) > 0 && (hasNumber(item.comments) || hasNumber(item.reactions)) ? ((Number(item.comments ?? 0) + Number(item.reactions ?? 0)) / observedViews(item)) * 1000 : null;
    const snapshot = snapshotMetricFor(item);
    const persistenceScore = snapshotComparison.previous ? (snapshot && !snapshot.isNew ? 100 : 0) : 50;
    const crossSpreadScore = Math.min(100, (groups.get(item.topic)?.length ?? 1) * 25);
    return weightedAvailable([{ value: rankScore, weight: 0.30 }, { value: percentileOrNull(item.views, candidateViews), weight: 0.25 }, { value: percentileOrNull(engagement, candidateEngagement), weight: 0.20 }, { value: persistenceScore, weight: 0.15 }, { value: crossSpreadScore, weight: 0.10 }]);
  };
  const used = new Set();
  const usedTitles = new Set();
  const choose = (label, sorted) => {
    const item = sorted.find((candidate) => !used.has(candidate.url) && !usedTitles.has(normalizeTitle(candidate.title)));
    if (!item) return null;
    used.add(item.url);
    usedTitles.add(normalizeTitle(item.title));
    const snapshot = snapshotMetricFor(item);
    return { label, item, viewsPerHour: viewsPerHourFor(item), velocityMeasured: Boolean(snapshot?.measured), snapshot, risingScore: label === "뜨는글" ? risingScore(item) : null };
  };
  const majorPost = choose("주요글", [...candidates].sort((a, b) => majorScore(b) - majorScore(a)));
  const risingPool = snapshotComparison.previous ? candidates.filter((item) => snapshotMetricFor(item)?.measured) : candidates.filter((item) => hasNumber(viewsPerHourFor(item)));
  const risingPost = choose("뜨는글", [...risingPool].sort((a, b) => risingScore(b) - risingScore(a)));
  const entryPool = snapshotComparison.previous ? candidates.filter((item) => snapshotMetricFor(item)?.isNew) : candidates;
  const entryPost = choose(snapshotComparison.previous ? "진입글" : "최신글", [...entryPool].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)));
  return { community, posts: [entryPost, risingPost, majorPost].filter(Boolean) };
}).filter(Boolean);

const dataFiles = (await readdir(resolve(projectRoot, "data")))
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < daily.date)
  .sort((a, b) => b.localeCompare(a));
const previousDaily = dataFiles[0]
  ? await readFile(resolve(projectRoot, "data", dataFiles[0]), "utf8").then(JSON.parse).catch(() => null)
  : null;
const historicalDailies = (await Promise.all(dataFiles.slice(0, 6).map((name) =>
  readFile(resolve(projectRoot, "data", name), "utf8").then(JSON.parse).catch(() => null)
))).filter(Boolean);
const rollingDailies = [...historicalDailies, daily];
const weekly = buildWeeklyTopics({
  dailies: rollingDailies,
  reportDate: daily.date,
  communityGroups: rules.communityGroups,
  normalization: rules.normalization,
  limit: 7
});
const expansionThemes = buildExpansionThemes({ weekly, dailies: rollingDailies, normalization: rules.normalization });
const weeklyPeriodLabel = weekly.collectedDays < weekly.daysRequested
  ? `부분 집계 ${weekly.collectedDays}/${weekly.daysRequested}일`
  : `최근 ${weekly.daysRequested}일`;
const rankingKey = (item) => `${String(item.source ?? "").trim().toLowerCase()}\u0000${String(item.keyword ?? "").trim().toLowerCase()}`;
const directChannelUrl = (item) => item.source?.includes("Google")
  ? `https://trends.google.com/trends/explore?date=now%201-d&geo=KR&q=${encodeURIComponent(item.keyword)}`
  : item.url;
const addMovement = (entries, previousEntries = []) => {
  const previousByKey = new Map(previousEntries.map((item) => [rankingKey(item), Number(item.rank)]));
  return entries.map((rawItem) => {
    const item = { ...rawItem, url: directChannelUrl(rawItem) };
    const previousRank = previousByKey.get(rankingKey(item));
    if (!Number.isFinite(previousRank)) return {
      ...item,
      movement: "NEW",
      movementClass: "new",
      comparison: "전일 신규",
      movementAnalysis: item.analysis ?? `전일 ${item.source} 상위 목록에 없었으나 현재 ${item.rank}위로 신규 진입했습니다. 공개 데이터만으로 구체적인 촉발 이슈는 확인되지 않았습니다.`
    };
    const change = previousRank - Number(item.rank);
    if (change > 0) return {
      ...item,
      movement: `▲ ${change}`,
      movementClass: "rising",
      comparison: `전일 ${previousRank}위 → 현재 ${item.rank}위`,
      movementAnalysis: item.analysis ?? `${item.source} 공개 순위에서 전일보다 ${change}단계 상승했습니다. 별도 언급량·검색량이 제공되지 않아 순위 상승 이상의 원인은 확인이 필요합니다.`
    };
    if (change < 0) return { ...item, movement: `▼ ${Math.abs(change)}`, movementClass: "declining", comparison: `전일 ${previousRank}위 → 현재 ${item.rank}위` };
    return { ...item, movement: "― 유지", movementClass: "major", comparison: `전일·현재 ${item.rank}위` };
  });
};
const searchRankings = addMovement(daily.channels?.search ?? [], previousDaily?.channels?.search ?? []);
const socialRankings = addMovement(daily.channels?.social ?? [], previousDaily?.channels?.social ?? []);
const analysisLabel = (item) => item.movement === "NEW" ? "신규 분석" : "상승 분석";
const formatChannelRanking = (item, index) => `- **${item.rank ?? index + 1}위 · ${item.keyword}** · **${item.movement}** — ${item.score === undefined ? "" : `${Number(item.score).toFixed(1)}점 · `}${item.source ?? "출처 미수집"}${item.metric ? ` · ${item.metric}` : ""} · ${item.comparison}${item.movementAnalysis ? `\n  - ${analysisLabel(item)}: ${item.movementAnalysis}` : ""}${item.url ? `\n  - URL: ${item.url}` : ""}`;
const communityTopics = new Set(topics.map((entry) => entry.topic));
const searchTopics = new Set(searchRankings.map((entry) => entry.keyword));
const socialTopics = new Set(socialRankings.map((entry) => entry.keyword));
const crossChannelTopics = [...new Set([...communityTopics, ...searchTopics, ...socialTopics])].map((keyword) => ({
  keyword,
  channels: [communityTopics.has(keyword) && "커뮤니티", searchTopics.has(keyword) && "검색", socialTopics.has(keyword) && "SNS"].filter(Boolean)
})).filter((entry) => entry.channels.length >= 2);

const researchFor = (topic) => daily.research?.[topic] ?? null;
const formatResearch = (entry) => {
  const research = researchFor(entry.topic);
  if (!research) return `- **${entry.topic}** — 외부 검증 미수집`;
  const terms = research.expandedKeywords?.join(", ") || "없음";
  const naver = research.naverTrend ? `네이버 ${Number(research.naverTrend.delta24h || 0) >= 0 ? "+" : ""}${research.naverTrend.delta24h || 0}%` : "네이버 미수집";
  const google = research.googleTrend ? `Google ${Number(research.googleTrend.delta24h || 0) >= 0 ? "+" : ""}${research.googleTrend.delta24h || 0}%` : "Google 미수집";
  const youtube = research.youtube ? `YouTube 기회 ${research.youtube.opportunityScore ?? "-"}점` : "YouTube 미수집";
  return `- **${entry.topic}** — ${naver} · ${google} · ${youtube}\n  - 확장어: ${terms}`;
};

const report = [
  `# ${daily.date} 커뮤니티 리서치`,
  "",
  `확인 시각: ${daily.checkedAt}`,
  `스냅샷 상태: ${snapshotStatus}`,
  `검색·SNS 확인 시각: ${daily.channelCheckedAt ?? "미수집"}`,
  `데이터 완성도: ${dataQualityScore.toFixed(1)}% (조회·댓글·공감·순위·후보수·게시시각 기준)`,
  `트렌드 점수 가중치: ${weights === learnedWeights ? `학습됨 (${learnedModel.trainedAt})` : "초기 고정값"}`,
  "",
  "## 표식 한눈에 보기",
  "",
  "| 표식 | 아주 쉽게 말하면 | 선정 기준 |",
  "|---|---|---|",
  "| 최신글 | 아직 비교할 지난 목록이 없을 때 가장 최근 글 | 첫 스냅샷에서만 표시 |",
  "| 진입글 | 방금 인기 목록에 새로 들어온 글 | 직전 스냅샷에는 없고 지금은 있음 |",
  "| 뜨는글 | 자기 커뮤니티에서 특히 빨라지는 글 | 실제 속도·커뮤니티 내 백분위·반응 증가·순위 상승·새로움 |",
  "| 주요글 | 지금 많은 사람이 보고 반응하는 중요한 글 | 순위·조회·반응·지속·다른 커뮤니티 확산 |",
  "| 뜰 것 같은 글 | 앞으로 더 커질 가능성이 높은 글 | 속도 40%·반응 30%·새로움 15%·확산 15%, 65점 이상 |",
  "| 실측 | 두 번 재서 진짜로 늘어난 속도 | 직전 조회수와 현재 조회수 비교 |",
  "| 추정 | 아직 한 번만 재서 계산한 예상 속도 | 현재 조회수 ÷ 글이 올라온 시간 |",
  "",
  "## 뜨는 주제",
  "",
  rising.length ? rising.map(formatTopic).join("\n") : "- 해당 없음",
  "",
  "## 주요 주제",
  "",
  major.length ? major.map(formatTopic).join("\n") : "- 해당 없음",
  "",
  "## 이번 주 영상 소재",
  "",
  videoCandidates.length
    ? videoCandidates.map((entry, index) => `${index + 1}. **${entry.topic}** — ${entry.trendScore.toFixed(1)}점 · ${entry.decision} · ${entry.communities.length}개 커뮤니티 · 조회 ${formatCount(entry.totalViews, "회")} · ${entry.needsVerification ? "팩트체크형 권장" : "설명·정리형 권장"}\n   - URL: ${entry.items.map((item) => item.url).join(" · ")}`).join("\n")
    : "- 해당 없음",
  "",
  "## 검색 트렌드 순위",
  "",
  searchRankings.length ? searchRankings.map(formatChannelRanking).join("\n") : "- 미수집",
  "",
  "## SNS 트렌드 순위",
  "",
  socialRankings.length ? socialRankings.map(formatChannelRanking).join("\n") : "- 미수집",
  "",
  "## 채널 교차 키워드",
  "",
  crossChannelTopics.length ? crossChannelTopics.map((entry) => `- **${entry.keyword}** — ${entry.channels.join(" · ")}`).join("\n") : "- 현재 교차 키워드 없음",
  "",
  "## 뜰 것 같은 영상",
  "",
  predictedVideos.length
    ? predictedVideos.map((entry, index) => `${index + 1}. **${entry.topic}** — 예측 ${entry.predictionScore.toFixed(1)}점 · 현재 조회 ${formatCount(entry.totalViews, "회")} · 시간당 ${formatVelocity(entry.viewsPerHour)}\n   - 근거: 조회속도 ${formatScore(entry.scores.viewVelocityScore)} · 반응 ${formatScore(entry.scores.commentsAndEngagementScore)} · 최신성 ${formatScore(entry.scores.freshnessScore)} · 파급력 ${formatScore(entry.scores.impactScore)}${entry.needsVerification ? " · 사실 확인 필요" : ""}\n   - URL: ${entry.items[0]?.url}`).join("\n")
    : "- 현재 기준 충족 후보 없음",
  "",
  "## 커뮤니티별 대표 글",
  "",
  ...communitySelections.map(({ community, posts }) => `### ${community.name}\n\n${posts.map((entry) => {
    const { label, item, viewsPerHour } = entry;
    const predicted = likelyPostByKey.get(postKey(item));
    return `- **${label}** — [${item.title}](${item.url}) · 내부 ${item.rank ?? "-"}위 · 조회 ${formatCount(observedViews(item), "회")} · ${entry.velocityMeasured ? "실측" : "추정"} 시간당 ${formatVelocity(viewsPerHour)}${hasNumber(entry.risingScore) ? ` · 뜨는 점수 ${entry.risingScore.toFixed(0)}` : ""}${entry.snapshot?.rankChange > 0 ? ` · 순위 ▲${entry.snapshot.rankChange}` : ""}${predicted ? ` · **뜰 것 같은 글 ${predicted.score.toFixed(1)}점**` : ""}`;
  }).join("\n")}`),
  "",
  `## 최근 7일 누적 주요 키워드 · ${weeklyPeriodLabel}`,
  "",
  "> 지속성 25% + 커뮤니티 확산 25% + 커뮤니티 규모를 보정한 조회 성과 25% + 댓글·반응 15% + 상승세 10%. 최신성은 최근 7일 포함 조건으로 적용하며 미수집 날짜를 0으로 넣지 않습니다.",
  "",
  "### 정식 주요 키워드",
  "",
  weekly.major.length ? weekly.major.map((entry, index) => `${index + 1}. **${entry.canonical}** — ${entry.score.toFixed(1)}점 · ${entry.status}${entry.externalSignals.length ? ` · 외부 확산 확인(${[...new Set(entry.externalSignals.map((signal) => signal.source))].join("·")})` : ""}${entry.sensitive ? " · 사실 확인 필요" : ""}\n   - ID ${entry.topicId} · ${entry.dates.length}일 등장 · ${entry.communities.length}개 커뮤니티\n   - 수집 조회 ${formatCount(entry.totalViews, "회")} · 중복 보정 조회 ${formatCount(entry.independentViews, "회")}\n   - 원문: ${[...new Set(entry.rows.map((row) => row.url).filter(Boolean))].slice(0, 3).join(" · ")}`).join("\n") : "- 아직 정식 기준을 충족한 키워드 없음",
  "",
  "### 관찰 후보",
  "",
  weekly.candidates.length ? weekly.candidates.map((entry, index) => `${index + 1}. **${entry.canonical}** — ${entry.score.toFixed(1)}점 · ${entry.status}${entry.sensitive ? " · 사실 확인 필요" : ""}\n   - ID ${entry.topicId} · ${entry.dates.length}일 등장 · ${entry.communities.length}개 커뮤니티\n   - 수집 조회 ${formatCount(entry.totalViews, "회")} · 중복 보정 조회 ${formatCount(entry.independentViews, "회")}\n   - 원문: ${[...new Set(entry.rows.map((row) => row.url).filter(Boolean))].slice(0, 2).join(" · ")}`).join("\n") : "- 관찰 후보 없음",
  "",
  "## 인접 주제·키워드 확장 테마",
  "",
  "> 관측 인접 키워드는 외부 리서치·검색·SNS에서 실제 확인된 표현입니다. 콘텐츠 각도는 제작용 기획안이며 관측 데이터나 기존 순위 점수로 취급하지 않습니다.",
  "",
  expansionThemes.length ? expansionThemes.map((entry) => `### ${entry.topic}\n\n**실제 관측 인접 키워드**\n\n${entry.observed.length ? entry.observed.map((item) => `- **${item.keyword}** — ${item.source}${item.url ? ` · ${item.url}` : ""}`).join("\n") : "- 아직 관측 근거 없음"}\n\n**콘텐츠 기획 각도**\n\n${entry.angles.map((angle) => `- **${angle.type} · ${angle.name}** — ${angle.risk}\n  - ${angle.reason}\n  - 참고 원문: ${angle.urls.join(" · ") || "미수집"}`).join("\n")}`).join("\n\n") : "- 확장 가능한 주제 없음"
].join("\n");

const outputPath = resolve(projectRoot, `reports/${daily.date}.md`);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${report}\n`, "utf8");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const topicCards = (entries, emptyText, status = "신규") => entries.length ? entries.map((entry) => `
  <article class="topic-card">
    <div class="topic-head"><h3>${escapeHtml(entry.topic)} · ${entry.trendScore.toFixed(1)}점</h3><div class="badges"><span class="status status-${status === "뜨는" ? "rising" : status === "주요" ? "major" : status === "하락" ? "declining" : "new"}">${status}</span>${entry.needsVerification ? '<span class="badge warning">확인 필요</span>' : '<span class="badge">검증 가능</span>'}</div></div>
    <p>${escapeHtml(entry.decision)} · ${entry.communities.map((id) => escapeHtml(communityMap.get(id)?.name ?? id)).join(" · ")} · 조회 ${formatCount(entry.totalViews, "회")} · 댓글 ${formatCount(entry.totalComments, "개")}</p>
    <p>조회 ${formatCount(entry.totalViews, "회")} · ${entry.velocityMeasured ? "실측" : "추정"} 시간당 ${formatVelocity(entry.viewsPerHour)} · 파급력 ${formatScore(entry.scores.impactScore)} · 조회성과 ${formatScore(entry.scores.viewPerformanceScore)} · 댓글/반응 ${formatScore(entry.scores.commentsAndEngagementScore)} · 최신성 ${formatScore(entry.scores.freshnessScore)}</p>
    <div class="links">${entry.items.map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(communityMap.get(item.community)?.name ?? item.community)} 원문</a>`).join("")}</div>
  </article>`).join("") : `<p class="empty">${escapeHtml(emptyText)}</p>`;

const researchCards = videoCandidates.map((entry) => {
  const research = researchFor(entry.topic);
  if (!research) return `<article class="topic-card"><h3>${escapeHtml(entry.topic)}</h3><p>외부 검증 미수집</p></article>`;
  const links = [research.naverTrend, research.googleTrend, research.youtube, research.naverSearch].filter((value) => value?.url);
  return `<article class="topic-card"><h3>${escapeHtml(entry.topic)}</h3><p>확장어: ${escapeHtml(research.expandedKeywords?.join(" · ") || "없음")}</p><p>네이버 ${escapeHtml(research.naverTrend?.delta24h ?? "-")}% · Google ${escapeHtml(research.googleTrend?.delta24h ?? "-")}% · YouTube 기회 ${escapeHtml(research.youtube?.opportunityScore ?? "-")}점</p><div class="links">${links.map((value) => `<a href="${escapeHtml(value.url)}" target="_blank" rel="noreferrer">검증 URL</a>`).join("")}</div></article>`;
}).join("");
const predictionCards = predictedVideos.map((entry,index)=>`<article class="video"><span class="rank">${index+1}</span><div><strong>${escapeHtml(entry.topic)} · 예측 ${entry.predictionScore.toFixed(1)}점</strong><div class="muted">현재 조회 ${formatCount(entry.totalViews, "회")} · ${entry.velocityMeasured ? "실측" : "추정"} 시간당 ${formatVelocity(entry.viewsPerHour)} · 조회속도 ${formatScore(entry.scores.viewVelocityScore)} · 반응 ${formatScore(entry.scores.commentsAndEngagementScore)}${entry.needsVerification?" · 사실 확인 필요":""}</div></div><a href="${escapeHtml(entry.items[0]?.url)}" target="_blank" rel="noreferrer">대표 URL</a></article>`).join("");
const sourceClass = (source = "") => source.includes("Google") ? "google" : source.includes("YouTube") ? "youtube" : source.includes("X ") ? "x" : "default";
const channelCards = (entries) => entries.map((item,index)=>`<article class="topic-card channel-${sourceClass(item.source)}"><div class="topic-head"><h3>${escapeHtml(item.rank ?? index+1)}위 · ${escapeHtml(item.keyword)}</h3><div class="badges"><span class="status status-${escapeHtml(item.movementClass)}">${escapeHtml(item.movement)}</span><span class="source source-${sourceClass(item.source)}">${escapeHtml(item.source ?? "출처 미수집")}</span></div></div><p>${item.score === undefined ? "" : `${Number(item.score).toFixed(1)}점 · `}${item.metric ? escapeHtml(item.metric) : ""}</p><p class="confidence">${escapeHtml(item.comparison)} · 전일 리포트 비교</p>${item.movementAnalysis ? `<p class="analysis"><strong>${analysisLabel(item)}:</strong> ${escapeHtml(item.movementAnalysis)}</p>` : ""}${item.url ? `<p class="visible-url"><strong>URL:</strong> <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a></p>` : ""}</article>`).join("");
const weeklyCardsFor = (entries, candidate = false) => entries.map((entry, index) => `<article class="weekly-card"><div class="weekly-rank">${index + 1}</div><div><div class="topic-head"><h3>${escapeHtml(entry.canonical)} · ${entry.score.toFixed(1)}점</h3><div class="badges"><span class="status status-${entry.status === "확산 중" ? "rising" : entry.status === "장기 생존" || entry.status === "단발 급등" ? "major" : "new"}">${escapeHtml(entry.status)}</span>${candidate ? '<span class="badge warning">관찰 후보</span>' : ""}${entry.externalSignals.length ? `<span class="badge external">외부 확산 확인</span>` : ""}${entry.sensitive ? '<span class="badge warning">사실 확인 필요</span>' : ""}</div></div><p class="topic-id">${escapeHtml(entry.topicId)}</p><p>${entry.dates.length}일 등장 · ${entry.communities.length}개 커뮤니티</p><div class="view-split"><span>수집 조회<strong>${formatCount(entry.totalViews, "회")}</strong></span><span>중복 보정 조회<strong>${formatCount(entry.independentViews, "회")}</strong></span></div><p class="score-detail">지속 ${entry.persistenceScore.toFixed(0)} · 확산 ${entry.spreadScore.toFixed(0)} · 보정 조회 ${formatScore(entry.viewScore)} · 반응 ${formatScore(entry.engagementScore)} · 상승 ${entry.directionScore.toFixed(0)}</p>${entry.aliases.size > 1 ? `<p class="aliases">관련 표현: ${escapeHtml([...entry.aliases].slice(0, 3).join(" · "))}</p>` : ""}<div class="links">${[...new Set(entry.rows.map((row) => row.url).filter(Boolean))].slice(0, 3).map((url, urlIndex) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">근거 ${urlIndex + 1}</a>`).join("")}${entry.externalSignals.slice(0, 2).map((signal) => `<a href="${escapeHtml(signal.url)}" target="_blank" rel="noreferrer">${escapeHtml(signal.source)} 확인</a>`).join("")}</div></div></article>`).join("");
const expansionCards = expansionThemes.map((entry) => `<article class="expansion-group"><h3>${escapeHtml(entry.topic)}</h3><div class="observed-box"><strong>데이터에서 관측된 인접 키워드</strong>${entry.observed.length ? `<div class="observed-tags">${entry.observed.map((item) => item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.keyword)} · ${escapeHtml(item.source)}</a>` : `<span>${escapeHtml(item.keyword)} · ${escapeHtml(item.source)}</span>`).join("")}</div>` : '<p>아직 관측 근거 없음</p>'}</div><h4 class="angle-title">제작용 콘텐츠 각도</h4><div class="expansion-grid">${entry.angles.map((angle) => `<div class="expansion-card"><div class="topic-head"><strong>${escapeHtml(angle.type)}</strong><span class="badge ${angle.risk === "사실 확인 필요" ? "warning" : ""}">${escapeHtml(angle.risk)}</span></div><h4>${escapeHtml(angle.name)}</h4><p>${escapeHtml(angle.reason)}</p><div class="links">${angle.urls.map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">참고 ${index + 1}</a>`).join("")}</div></div>`).join("")}</div></article>`).join("");

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(daily.date)} 커뮤니티 리서치</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#697386;--line:#e5e9f2;--hot:#ed4b43;--main:#5c5ce2;--soft:#eef0ff;--warn:#9a5b00;--new:#1677ff;--rising:#f97316;--major:#7c3aed;--declining:#64748b;--google:#4285f4;--youtube:#ff0033;--x:#111827}@media(prefers-color-scheme:dark){:root{--bg:#11141b;--panel:#1a1f2a;--text:#eef2ff;--muted:#9aa5ba;--line:#303848;--soft:#292c47;--warn:#ffc266;--x:#e5e7eb}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}main{max-width:1080px;margin:auto;padding:32px 20px 64px}header{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:24px}h1,h2,h3,p{margin-top:0}h1{margin-bottom:8px}.muted,.topic-card p{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}.stat,.topic-card,.video,.community-row{background:var(--panel);border:1px solid var(--line);border-radius:14px}.stat{padding:18px}.stat strong{display:block;font-size:28px;margin-top:6px}.legend{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 30px}.status,.source{display:inline-flex;align-items:center;font-size:12px;font-weight:700;padding:5px 9px;border-radius:999px;color:#fff;white-space:nowrap}.status-new{background:var(--new)}.status-rising{background:var(--rising)}.status-major{background:var(--major)}.status-declining{background:var(--declining)}.source-google{background:var(--google)}.source-youtube{background:var(--youtube)}.source-x{background:var(--x)}.source-default{background:var(--declining)}.section{margin-top:34px}.section-title{display:flex;align-items:center;gap:8px}.dot{width:10px;height:10px;border-radius:50%;background:var(--main)}.dot.hot{background:var(--hot)}.topics{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.topic-card{padding:18px;border-left-width:4px}.channel-google{border-left-color:var(--google)}.channel-youtube{border-left-color:var(--youtube)}.channel-x{border-left-color:var(--x)}.topic-head{display:flex;justify-content:space-between;gap:12px}.topic-head h3{margin-bottom:8px}.badges{display:flex;gap:6px;align-items:flex-start}.badge{font-size:12px;background:var(--soft);padding:5px 8px;border-radius:999px;white-space:nowrap}.badge.warning{color:var(--warn)}.confidence{font-size:12px}.links{display:flex;gap:8px;flex-wrap:wrap}.links a,.community-row a,.visible-url a{color:var(--main);text-decoration:none}.visible-url{font-size:12px;overflow-wrap:anywhere;word-break:break-all}.videos{display:grid;gap:10px}.video{padding:16px;display:grid;grid-template-columns:42px 1fr auto;gap:12px;align-items:center}.rank{font-size:24px;color:var(--main);font-weight:700}.community-list{display:grid;gap:8px}.community-row{padding:13px 15px;display:grid;grid-template-columns:130px 1fr auto;gap:12px;align-items:center}.prediction-badge{display:inline-flex;margin-left:8px;padding:4px 8px;border-radius:999px;background:var(--rising);color:#fff;font-size:11px;font-weight:800;white-space:nowrap}.empty{color:var(--muted)}@media(max-width:680px){header{display:block}.stats,.topics{grid-template-columns:1fr}.topic-head{display:block}.badges{margin-bottom:10px}.video{grid-template-columns:34px 1fr}.video>a{grid-column:2}.community-row{grid-template-columns:1fr}.community-row span{font-size:13px;color:var(--muted)}}
.community-list{gap:18px}.community-group{display:grid;gap:8px}.community-group h3{margin:0 0 2px}.community-row{grid-template-columns:76px 1fr auto}.community-row small{color:var(--muted)}
.guide{margin:20px 0 28px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:16px}.guide h2{font-size:20px;margin-bottom:12px}.guide-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.guide-item{display:grid;grid-template-columns:105px 1fr;gap:10px;align-items:center;padding:11px;background:var(--bg);border-radius:11px}.guide-item p{margin:0;font-size:13px;color:var(--muted)}.guide-item strong{display:block;color:var(--text);margin-bottom:2px}@media(max-width:680px){.guide-grid{grid-template-columns:1fr}.guide-item{grid-template-columns:95px 1fr}}
.hero{position:relative;overflow:hidden;display:grid;grid-template-columns:1.4fr .9fr;gap:28px;align-items:stretch;margin-bottom:22px;padding:30px;border:1px solid rgba(92,92,226,.22);border-radius:24px;background:linear-gradient(135deg,var(--panel) 0%,var(--soft) 100%);box-shadow:0 18px 45px rgba(37,45,85,.09)}.hero:after{content:"";position:absolute;width:240px;height:240px;right:-90px;top:-120px;border-radius:50%;background:linear-gradient(135deg,rgba(92,92,226,.20),rgba(249,115,22,.10));filter:blur(2px)}.hero-main,.hero-side{position:relative;z-index:1}.hero-kicker{display:inline-flex;margin-bottom:12px;color:var(--main);font-size:12px;font-weight:800;letter-spacing:.14em}.hero h1{margin:0 0 12px;font-size:clamp(34px,5vw,54px);line-height:1;letter-spacing:-.045em}.hero-lead{max-width:620px;margin-bottom:20px;color:var(--muted);font-size:15px;line-height:1.6}.hero-meta{display:flex;flex-wrap:wrap;gap:8px}.hero-chip{display:inline-flex;padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12px;font-weight:700}.hero-side{display:grid;gap:10px;align-content:center}.hero-status{padding:14px;border:1px solid var(--line);border-radius:15px;background:rgba(255,255,255,.62)}@media(prefers-color-scheme:dark){.hero-status{background:rgba(17,20,27,.45)}}.hero-status span{display:block;margin-bottom:5px;color:var(--muted);font-size:11px;font-weight:700}.hero-status strong{font-size:15px;line-height:1.45}.hero-numbers{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.hero-number{padding:13px;border-radius:14px;background:var(--panel);border:1px solid var(--line)}.hero-number strong{display:block;font-size:23px;color:var(--main)}.hero-number span{font-size:11px;color:var(--muted)}@media(max-width:760px){.hero{grid-template-columns:1fr;padding:22px}.hero-side{grid-template-columns:1fr}.hero h1{font-size:38px}}
.weekly-note{padding:13px 15px;border-left:4px solid var(--main);border-radius:10px;background:var(--soft);color:var(--muted)}.weekly-subhead{display:flex;align-items:center;gap:8px;margin:22px 0 10px}.weekly-list{display:grid;gap:10px}.weekly-card{display:grid;grid-template-columns:44px 1fr;gap:12px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px}.weekly-rank{font-size:27px;font-weight:800;color:var(--main)}.weekly-card p{margin-bottom:8px;color:var(--muted)}.topic-id{font:11px ui-monospace,monospace}.view-split{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.view-split span{padding:8px 11px;border-radius:9px;background:var(--bg);font-size:11px;color:var(--muted)}.view-split strong{display:block;margin-top:2px;color:var(--text);font-size:15px}.score-detail,.aliases{font-size:12px}.badge.external{background:#e7f7ee;color:#157347}.candidate-list .weekly-card{border-style:dashed}.expansion-list{display:grid;gap:18px}.expansion-group{padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px}.observed-box{padding:13px;border-radius:11px;background:var(--soft)}.observed-box p{margin:7px 0 0;color:var(--muted)}.observed-tags{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.observed-tags a,.observed-tags span{padding:6px 9px;border-radius:999px;background:var(--panel);font-size:12px;color:var(--main);text-decoration:none}.angle-title{margin:16px 0 9px}.expansion-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.expansion-card{padding:14px;border-radius:12px;background:var(--bg);border-top:4px solid var(--main)}.expansion-card h4{margin:12px 0 8px}.expansion-card p{font-size:13px;color:var(--muted)}@media(max-width:760px){.expansion-grid{grid-template-columns:1fr}.weekly-card{grid-template-columns:34px 1fr}}
</style></head><body><main>
<header class="hero"><div class="hero-main"><span class="hero-kicker">DAILY COMMUNITY RESEARCH</span><h1>커뮤니티 리서치</h1><p class="hero-lead">여러 커뮤니티의 인기 글을 모아 지금 막 들어온 글, 빠르게 커지는 글, 오래 주목받는 글을 구분한 일일 리포트입니다.</p><div class="hero-meta"><span class="hero-chip">${escapeHtml(daily.date)}</span><span class="hero-chip">기준 ${escapeHtml(daily.checkedAt.slice(11,16))}</span><span class="hero-chip">${weights === learnedWeights ? "학습 가중치" : "초기 가중치"}</span></div></div><div class="hero-side"><div class="hero-status"><span>스냅샷 상태</span><strong>${escapeHtml(snapshotStatus)}</strong></div><div class="hero-numbers"><div class="hero-number"><strong>${seenCommunities.size}/${rules.communities.length}</strong><span>수집 커뮤니티</span></div><div class="hero-number"><strong>${items.length}</strong><span>분석 게시물</span></div></div></div></header>
<section class="stats"><div class="stat"><span>뜨는 주제</span><strong>${rising.length}</strong></div><div class="stat"><span>주요 주제</span><strong>${major.length}</strong></div><div class="stat"><span>데이터 완성도</span><strong>${dataQualityScore.toFixed(0)}%</strong></div></section>
<section class="guide"><h2>표식은 이렇게 보면 돼요</h2><div class="guide-grid">
<div class="guide-item"><span class="status status-new">최신글</span><p><strong>아직 비교 전인 최근 글</strong>첫 번째 측정이라 새로 들어왔는지는 아직 몰라요.</p></div>
<div class="guide-item"><span class="status status-new">진입글</span><p><strong>방금 들어온 글</strong>지난번 인기 목록에는 없었는데 지금 새로 나타났어요.</p></div>
<div class="guide-item"><span class="status status-rising">뜨는글</span><p><strong>자기 커뮤니티에서 빨라지는 글</strong>실제 속도와 반응·순위 상승을 함께 봐요.</p></div>
<div class="guide-item"><span class="status status-major">주요글</span><p><strong>지금 중요한 글</strong>순위·조회·반응이 높고 오래 살아남거나 여러 곳에 퍼졌어요.</p></div>
<div class="guide-item"><span class="prediction-badge">뜰 것 같은 글</span><p><strong>앞으로 더 커질 후보</strong>속도 40%·반응 30%·새로움 15%·확산 15%로 65점 이상이에요.</p></div>
<div class="guide-item"><span class="badge">실측</span><p><strong>두 번 재본 진짜 속도</strong>직전 조회수와 지금 조회수를 비교했어요.</p></div>
<div class="guide-item"><span class="badge warning">추정</span><p><strong>한 번만 재본 예상 속도</strong>다음 스냅샷이 생기면 실측으로 바뀌어요.</p></div>
</div></section>
<div class="legend"><span class="status status-new">신규</span><span class="status status-rising">뜨는</span><span class="status status-major">주요</span><span class="status status-declining">하락</span><span class="source source-google">Google 검색</span><span class="source source-x">X</span><span class="source source-youtube">YouTube</span></div>
<section class="section"><h2 class="section-title"><span class="dot hot"></span>뜨는 주제</h2><div class="topics">${topicCards(rising,"해당 없음","뜨는")}</div></section>
<section class="section"><h2 class="section-title"><span class="dot"></span>주요 주제</h2><div class="topics">${topicCards(major,"해당 없음","주요")}</div></section>
<section class="section"><h2>이번 주 무조건 검토할 영상 소재</h2><div class="videos">${videoCandidates.map((entry,index)=>`<article class="video"><span class="rank">${index+1}</span><div><strong>${escapeHtml(entry.topic)} · ${entry.trendScore.toFixed(1)}점</strong><div class="muted">${escapeHtml(entry.decision)} · ${entry.communities.length}개 커뮤니티 · 조회 ${formatCount(entry.totalViews, "회")} · ${entry.needsVerification?"팩트체크형":"설명·정리형"}</div></div><a href="${escapeHtml(entry.items[0]?.url)}" target="_blank" rel="noreferrer">대표 URL</a></article>`).join("")||'<p class="empty">해당 없음</p>'}</div></section>
<section class="section"><h2>검색 트렌드 순위</h2><div class="topics">${channelCards(searchRankings)||'<p class="empty">미수집</p>'}</div></section>
<section class="section"><h2>SNS 트렌드 순위</h2><div class="topics">${channelCards(socialRankings)||'<p class="empty">미수집</p>'}</div></section>
<section class="section"><h2>채널 교차 키워드</h2><div class="topics">${crossChannelTopics.map((entry)=>`<article class="topic-card"><h3>${escapeHtml(entry.keyword)}</h3><p>${escapeHtml(entry.channels.join(" · "))}</p></article>`).join("")||'<p class="empty">현재 교차 키워드 없음</p>'}</div></section>
<section class="section"><h2>뜰 것 같은 영상</h2><p class="muted">최근 12시간 후보 중 조회속도·반응률·최신성·파급력을 결합한 예측입니다.</p><div class="videos">${predictionCards||'<p class="empty">현재 기준 충족 후보 없음</p>'}</div></section>
<section class="section"><h2>커뮤니티별 대표 글</h2><p class="muted">첫 측정은 최신글만 표시하고, 두 번째부터 진입글을 판정합니다. 뜨는글은 커뮤니티 규모를 보정한 상승점수, 주요글은 순위·조회·반응·지속성·교차 확산으로 선정합니다.</p><div class="community-list">${communitySelections.map(({community,posts})=>`<article class="community-group"><h3>${escapeHtml(community.name)} <span class="badge">${posts.length}개 글</span></h3>${posts.map((entry)=>{const {label,item,viewsPerHour}=entry;const predicted=likelyPostByKey.get(postKey(item));const labelClass=label==="진입글"||label==="최신글"?"new":label==="뜨는글"?"rising":"major";return `<div class="community-row"><span class="status status-${labelClass}">${label}</span><span><strong>${escapeHtml(item.title)}</strong><br><small>내부 ${escapeHtml(item.rank??"-")}위 · 조회 ${formatCount(observedViews(item),"회")} · ${entry.velocityMeasured?"실측":"추정"} 시간당 ${formatVelocity(viewsPerHour)}${hasNumber(entry.risingScore)?` · 뜨는 점수 ${entry.risingScore.toFixed(0)}`:""}${entry.snapshot?.rankChange>0?` · 순위 ▲${entry.snapshot.rankChange}`:""}</small>${predicted?`<span class="prediction-badge">뜰 것 같은 글 ${predicted.score.toFixed(1)}점</span>`:""}</span><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">원문 보기</a></div>`}).join("")}</article>`).join("")}</div></section>
<section class="section"><h2>최근 7일 누적 주요 키워드 <span class="badge">${escapeHtml(weeklyPeriodLabel)}</span></h2><p class="weekly-note">지속성 25% + 커뮤니티 확산 25% + 커뮤니티 규모를 보정한 조회 성과 25% + 댓글·반응 15% + 상승세 10%. 최신성은 최근 7일 포함 조건으로 적용하며 미수집 날짜를 0으로 넣지 않습니다.</p><h3 class="weekly-subhead">정식 주요 키워드 <span class="badge">2일 이상 또는 3개 이상 커뮤니티</span></h3><div class="weekly-list">${weeklyCardsFor(weekly.major)||'<p class="empty">아직 정식 기준을 충족한 키워드 없음</p>'}</div><h3 class="weekly-subhead">관찰 후보 <span class="badge warning">하루 관측</span></h3><div class="weekly-list candidate-list">${weeklyCardsFor(weekly.candidates,true)||'<p class="empty">관찰 후보 없음</p>'}</div></section>
<section class="section"><h2>인접 주제·키워드 확장 테마</h2><p class="weekly-note">관측 인접 키워드는 외부 리서치·검색·SNS에서 실제 확인된 표현입니다. 콘텐츠 각도는 제작용 기획안이며 관측 데이터나 기존 순위 점수로 취급하지 않습니다.</p><div class="expansion-list">${expansionCards||'<p class="empty">확장 가능한 주제 없음</p>'}</div></section>
</main></body></html>`;

const htmlPath = resolve(projectRoot, `reports/${daily.date}.html`);
await writeFile(htmlPath, html, "utf8");

const reportsDir = resolve(projectRoot, "reports");
const reportFiles = (await readdir(reportsDir))
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/.test(name))
  .sort((a, b) => b.localeCompare(a));
const indexHtml = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>커뮤니티 리서치 누적 리포트</title><style>
:root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#697386;--line:#e5e9f2;--accent:#5c5ce2}@media(prefers-color-scheme:dark){:root{--bg:#11141b;--panel:#1a1f2a;--text:#eef2ff;--muted:#9aa5ba;--line:#303848}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}main{max-width:900px;margin:auto;padding:32px 20px 64px}h1{margin-bottom:8px}.muted{color:var(--muted)}.reports{display:grid;gap:10px;margin-top:28px}.report{display:grid;grid-template-columns:120px 1fr auto;gap:16px;align-items:center;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px}.report:first-child{border-color:var(--accent)}.latest{font-size:12px;color:var(--accent)}a{color:var(--accent);text-decoration:none}@media(max-width:560px){.report{grid-template-columns:1fr}.latest{grid-row:1}}
</style></head><body><main><h1>커뮤니티 리서치 누적 리포트</h1><p class="muted">최신 리포트가 항상 최상단에 표시됩니다.</p><div class="reports">${reportFiles.map((file,index)=>{const date=file.replace(".html","");return `<article class="report"><strong>${escapeHtml(date)}</strong><span>${index===0?'<span class="latest">최신 리포트</span>':'일일 커뮤니티 리서치'}</span><a href="./${escapeHtml(file)}">리포트 열기</a></article>`}).join("")}</div></main></body></html>`;
const indexPath = resolve(reportsDir, "index.html");
await writeFile(indexPath, indexHtml, "utf8");
console.log(`${outputPath}\n${htmlPath}\n${indexPath}`);
