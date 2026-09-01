import { jaccardSimilarity, normalizeTitle } from "./topic-normalizer.mjs";

const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const clamp = (value) => Math.max(0, Math.min(100, value));
const percentile = (value, values) => {
  if (!hasNumber(value) || !values.length) return null;
  if (values.length === 1) return 100;
  const below = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return ((below + Math.max(0, equal - 1) / 2) / (values.length - 1)) * 100;
};
const weightedAvailable = (entries) => {
  const available = entries.filter(({ value }) => hasNumber(value));
  const total = available.reduce((sum, entry) => sum + entry.weight, 0);
  return total ? available.reduce((sum, entry) => sum + Number(entry.value) * entry.weight, 0) / total : 0;
};
const dateDistance = (left, right) => Math.round((new Date(`${right}T12:00:00+09:00`) - new Date(`${left}T12:00:00+09:00`)) / 86_400_000);

export function canonicalizeKeyword(value, options = {}) {
  const cleaned = normalizeTitle(value, options)
    .replace(/^(단독|속보|충격|실시간|현재)\s+/i, "")
    .replace(/(^|\s)\d{1,2}일(?=\s|$)/g, " ")
    .replace(/향년\s*\d{1,3}세/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 42 ? cleaned.slice(0, 42).replace(/\s+\S*$/, "").trim() : cleaned;
}

function stableTopicId(value) {
  let hash = 2166136261;
  for (const char of String(value).toLowerCase()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `topic-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function estimateIndependentViews(rows, normalization) {
  const copies = [];
  for (const row of rows) {
    const title = normalizeTitle(row.title || row.topic, normalization);
    let copy = copies.find((entry) => jaccardSimilarity(entry.title, title, normalization) >= 0.76);
    if (!copy) {
      copy = { title, rows: [] };
      copies.push(copy);
    }
    copy.rows.push(row);
  }
  const maxima = copies.map((copy) => copy.rows.map((row) => row.views).filter(hasNumber)).filter((values) => values.length).map((values) => Math.max(...values));
  return { duplicateClusters: copies.length, independentViews: maxima.length ? maxima.reduce((sum, value) => sum + value, 0) : null };
}

export function selectRollingDailies(dailies, reportDate, days = 7) {
  return dailies
    .filter((daily) => daily?.date && dateDistance(daily.date, reportDate) >= 0 && dateDistance(daily.date, reportDate) < days)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function buildWeeklyTopics({ dailies, reportDate, communityGroups = {}, normalization = {}, limit = 7 }) {
  const window = selectRollingDailies(dailies, reportDate, 7);
  const collectedDays = new Set(window.map((daily) => daily.date)).size;
  const groups = [];

  for (const daily of window) {
    for (const item of daily.items ?? []) {
      const originalTopic = normalizeTitle(item.topic || item.title, normalization);
      const candidate = canonicalizeKeyword(originalTopic, normalization);
      if (!candidate || !/[가-힣A-Za-z0-9]{2,}/.test(candidate)) continue;
      let group = groups.find((entry) => entry.canonical === candidate || jaccardSimilarity(entry.canonical, candidate, normalization) >= 0.72);
      if (!group) {
        group = { canonical: candidate, aliases: new Set(), rows: [] };
        groups.push(group);
      }
      group.aliases.add(String(item.topic || originalTopic));
      group.rows.push({ ...item, date: daily.date });
    }
  }

  const communityRows = new Map();
  for (const daily of window) for (const row of daily.items ?? []) {
    const list = communityRows.get(row.community) ?? [];
    list.push(row);
    communityRows.set(row.community, list);
  }
  const channelRows = window.flatMap((daily) => [...(daily.channels?.search ?? []), ...(daily.channels?.social ?? [])]);

  const raw = groups.map((group) => {
    const dates = [...new Set(group.rows.map((row) => row.date))].sort();
    const communities = [...new Set(group.rows.map((row) => row.community))];
    const communityGroupCount = new Set(communities.map((id) => communityGroups[id] ?? id)).size;
    const views = group.rows.map((row) => row.views).filter(hasNumber).map(Number);
    const totalViews = views.length ? views.reduce((sum, value) => sum + value, 0) : null;
    const { duplicateClusters, independentViews } = estimateIndependentViews(group.rows, normalization);
    const engagementRows = group.rows.filter((row) => hasNumber(row.views) && Number(row.views) > 0 && (hasNumber(row.comments) || hasNumber(row.reactions)));
    const engagementRate = engagementRows.length
      ? engagementRows.reduce((sum, row) => sum + (Number(row.comments ?? 0) + Number(row.reactions ?? 0)) / Number(row.views), 0) / engagementRows.length
      : null;
    const adjustedViewScores = group.rows.map((row) => percentile(row.views, (communityRows.get(row.community) ?? []).map((item) => item.views).filter(hasNumber))).filter(hasNumber);
    const adjustedRankScores = group.rows.filter((row) => hasNumber(row.rank) && hasNumber(row.candidateCount)).map((row) => clamp(((Number(row.candidateCount) - Number(row.rank) + 1) / Math.max(1, Number(row.candidateCount))) * 100));
    const adjustedViewPerformance = weightedAvailable([
      { value: adjustedViewScores.length ? Math.max(...adjustedViewScores) : null, weight: 0.75 },
      { value: adjustedRankScores.length ? Math.max(...adjustedRankScores) : null, weight: 0.25 }
    ]);
    const externalSignals = channelRows.filter((channel) => jaccardSimilarity(group.canonical, channel.keyword, normalization) >= 0.55)
      .map((channel) => ({ keyword: channel.keyword, source: channel.source, url: channel.url }));
    const latestCount = group.rows.filter((row) => row.date === reportDate).length;
    const previousDate = window.at(-2)?.date;
    const previousCount = previousDate ? group.rows.filter((row) => row.date === previousDate).length : null;
    const sensitive = group.rows.some((row) => row.needsVerification) || /(사망|별세|범죄|의혹|논란|폭로|정치|사고|학폭|피해)/.test(group.canonical);
    return { ...group, topicId: stableTopicId(group.canonical), dates, communities, communityGroupCount, totalViews, independentViews, duplicateClusters, engagementRate, adjustedViewPerformance, externalSignals, sensitive, latestCount, previousCount };
  });

  const engagementValues = raw.map((entry) => entry.engagementRate).filter(hasNumber);
  const topics = raw.map((entry) => {
    const persistenceScore = collectedDays ? (entry.dates.length / collectedDays) * 100 : 0;
    const communityScore = clamp(entry.communities.length * 20);
    const groupScore = clamp(entry.communityGroupCount * 25);
    const spreadScore = communityScore * 0.65 + groupScore * 0.35;
    const viewScore = entry.adjustedViewPerformance;
    const engagementScore = percentile(entry.engagementRate, engagementValues);
    const directionScore = entry.dates.length < 2 || entry.previousCount === null ? 50 : entry.latestCount > entry.previousCount ? 100 : entry.latestCount === entry.previousCount ? 55 : 20;
    const latestDate = entry.dates.at(-1);
    const freshnessScore = latestDate === reportDate ? 100 : dateDistance(latestDate, reportDate) === 1 ? 70 : 30;
    const score = weightedAvailable([
      { value: persistenceScore, weight: 0.25 }, { value: spreadScore, weight: 0.25 },
      { value: viewScore, weight: 0.25 }, { value: engagementScore, weight: 0.15 },
      { value: directionScore, weight: 0.10 }
    ]);
    const eligible = entry.dates.length >= 2 || (entry.communities.length >= 3 && (viewScore >= 70 || engagementScore >= 70));
    const status = entry.dates.length === 1 && entry.communities.length >= 3 ? "단발 급등"
      : entry.dates.length === 1 ? "이번 주 신규"
      : entry.dates.length >= 3 && latestDate === reportDate ? "장기 생존"
      : entry.previousCount !== null && entry.latestCount > entry.previousCount ? "확산 중"
      : entry.previousCount !== null && entry.latestCount > 0 && entry.latestCount === entry.previousCount ? "유지"
      : "이번 주 신규";
    return { ...entry, score, eligible, status, persistenceScore, spreadScore, viewScore, engagementScore, directionScore, freshnessScore };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);

  return {
    daysRequested: 7, collectedDays, windowStart: window[0]?.date ?? reportDate, windowEnd: reportDate,
    major: topics.filter((entry) => entry.eligible).slice(0, limit),
    candidates: topics.filter((entry) => !entry.eligible).slice(0, limit),
    topics: [...topics.filter((entry) => entry.eligible).slice(0, limit), ...topics.filter((entry) => !entry.eligible).slice(0, limit)]
  };
}

function topicType(topic) {
  if (/(별세|사망|부고|추모)/.test(topic)) return "person";
  if (/(가격|인상|할인|제품|출시|구매|항공|여행)/.test(topic)) return "consumer";
  if (/(논란|갈등|민심|갑질|의혹|폭로|반발)/.test(topic)) return "debate";
  if (/(방법|정리|건강|증상|요리|생활)/.test(topic)) return "howto";
  if (/(사건|사고|피해|화재|범죄|체포)/.test(topic)) return "incident";
  return "general";
}

function plannedThemes(topic) {
  const templates = {
    person: [`${topic}: 확인된 사실과 인물 정리`, `${topic}: 주요 활동과 다시 주목받는 장면`, `${topic}: 온라인 반응과 후속 보도`],
    consumer: [`${topic}: 실제 비용과 선택지 비교`, `${topic}: 관심이 커진 원인`, `${topic}: 소비자가 받을 영향과 대안`],
    debate: [`${topic}: 논란의 시작과 핵심 쟁점`, `${topic}: 찬반 주장의 근거 비교`, `${topic}: 비슷한 과거 사례와 다음 전개`],
    howto: [`${topic}: 실제로 따라 하는 방법`, `${topic}: 실패하기 쉬운 지점`, `${topic}: 비용·시간·대체 방법 비교`],
    incident: [`${topic}: 지금까지 확인된 시간순 정리`, `${topic}: 원인과 책임 쟁점`, `${topic}: 피해와 후속 조치`],
    general: [`${topic}: 1분 핵심 정리`, `${topic}: 갑자기 화제가 된 이유`, `${topic}: 다음에 이어질 인접 이슈`]
  };
  return templates[topicType(topic)];
}

export function buildExpansionThemes({ weekly, dailies, normalization = {}, coreLimit = 5, themesPerTopic = 3 }) {
  const researchByTopic = new Map();
  for (const daily of dailies) for (const [topic, research] of Object.entries(daily.research ?? {})) researchByTopic.set(normalizeTitle(topic, normalization), research);

  return [...weekly.major, ...weekly.candidates].slice(0, coreLimit).map((entry) => {
    const researchKey = [...researchByTopic.keys()].find((topic) => jaccardSimilarity(topic, entry.canonical, normalization) >= 0.55);
    const research = researchByTopic.get(researchKey);
    const observed = [...new Set([
      ...(research?.expandedKeywords ?? []).map((keyword) => ({ keyword, source: "외부 리서치", url: research?.naverSearch?.url ?? research?.googleTrend?.url ?? null })),
      ...entry.externalSignals.map((signal) => ({ keyword: signal.keyword, source: signal.source, url: signal.url }))
    ].map((item) => JSON.stringify(item)))].map(JSON.parse).slice(0, 5);
    const angles = plannedThemes(entry.canonical).slice(0, themesPerTopic);
    return {
      topic: entry.canonical,
      topicId: entry.topicId,
      observed,
      angles: angles.map((name, index) => ({
        name,
        type: index === 0 ? "직접 확장" : index === 1 ? "원인·맥락" : "비교·응용",
        reason: `${topicType(entry.canonical) === "general" ? "일반" : "주제 유형"}에 맞춘 콘텐츠 기획 확장`,
        risk: entry.sensitive ? "사실 확인 필요" : "일반 검토",
        urls: [...new Set(entry.rows.map((row) => row.url).filter(Boolean))].slice(0, 2)
      }))
    };
  });
}
