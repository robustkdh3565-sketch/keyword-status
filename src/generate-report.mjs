import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputArg = process.argv.find((arg) => arg.endsWith(".json"));
const checkOnly = process.argv.includes("--check");

if (!inputArg) {
  console.error("사용법: npm run report -- data/YYYY-MM-DD.json");
  process.exit(1);
}

const rules = JSON.parse(await readFile(resolve(projectRoot, "config/rules.json"), "utf8"));
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
  if (seenCommunities.has(item.community)) errors.push(`${item.community}는 하루에 한 항목만 입력할 수 있습니다.`);
  seenCommunities.add(item.community);
  for (const key of ["topic", "title", "url", "publishedAt"]) {
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
const percentile = (value, values) => {
  if (!values.length) return 0;
  if (values.length === 1) return 100;
  const below = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return ((below + Math.max(0, equal - 1) / 2) / (values.length - 1)) * 100;
};
const itemMetrics = (daily.items ?? []).map((item) => ({
  item,
  views: Number(item.views || 0),
  comments: Number(item.comments || 0),
  reactions: Number(item.reactions || 0),
  engagement: ((Number(item.comments || 0) + Number(item.reactions || 0)) / Math.max(1, Number(item.views || 0))) * 1000
}));
const viewValues = itemMetrics.map((entry) => entry.views);
const commentValues = itemMetrics.map((entry) => entry.comments);
const reactionValues = itemMetrics.map((entry) => entry.reactions);
const engagementValues = itemMetrics.map((entry) => entry.engagement);
const metricByItem = new Map(itemMetrics.map((entry) => [entry.item, {
  viewScore: percentile(entry.views, viewValues),
  commentScore: percentile(entry.comments, commentValues),
  reactionScore: percentile(entry.reactions, reactionValues),
  engagementScore: percentile(entry.engagement, engagementValues)
}]));
const groups = new Map();
for (const item of daily.items) {
  const group = groups.get(item.topic) ?? [];
  group.push(item);
  groups.set(item.topic, group);
}

const topics = [...groups.entries()].map(([topic, items]) => {
  const newestAgeHours = Math.min(...items.map((item) => (checkedAt - new Date(item.publishedAt)) / 3_600_000));
  const communities = [...new Set(items.map((item) => item.community))];
  const communityCount = communities.length;
  const crossCommunityScore = communityCount >= 5 ? 100 : communityCount === 4 ? 85 : communityCount === 3 ? 70 : communityCount === 2 ? 50 : 20;
  const featureRows = items.map((item) => {
    const metrics = metricByItem.get(item);
    const candidateCount = Math.max(2, Number(item.candidateCount || 10));
    const rank = Math.min(candidateCount, Math.max(1, Number(item.rank || 1)));
    const channelRankScore = (1 - (rank - 1) / (candidateCount - 1)) * 100;
    const ageHours = Math.max(0, (checkedAt - new Date(item.publishedAt)) / 3_600_000);
    const freshnessScore = Math.max(0, Math.min(100, 100 * Math.exp((-Math.log(2) * ageHours) / 12)));
    return { ...metrics, channelRankScore, freshnessScore };
  });
  const maxOf = (key) => Math.max(...featureRows.map((row) => row[key]));
  const channelRankScore = maxOf("channelRankScore");
  const commentScore = maxOf("commentScore");
  const engagementScore = maxOf("engagementScore");
  const commentsAndEngagementScore = (commentScore + engagementScore) / 2;
  const reactionScore = maxOf("reactionScore");
  const viewScore = maxOf("viewScore");
  const freshnessScore = maxOf("freshnessScore");
  const weights = rules.scoring.weights;
  const trendScore =
    crossCommunityScore * weights.crossCommunity +
    channelRankScore * weights.channelRank +
    commentsAndEngagementScore * weights.commentsAndEngagement +
    reactionScore * weights.reactions +
    viewScore * weights.views +
    freshnessScore * weights.freshness;
  const decision = trendScore >= rules.classification.mustProduceScore ? "반드시 제작" : trendScore >= rules.classification.priorityScore ? "제작 우선" : trendScore >= rules.classification.observeScore ? "추가 관찰" : "제외";
  return {
    topic,
    items,
    communities,
    newestAgeHours,
    totalComments: items.reduce((sum, item) => sum + Number(item.comments || 0), 0),
    totalViews: items.reduce((sum, item) => sum + Number(item.views || 0), 0),
    needsVerification: items.some((item) => item.needsVerification),
    trendScore,
    decision,
    scores: { crossCommunityScore, channelRankScore, commentsAndEngagementScore, reactionScore, viewScore, freshnessScore }
  };
});

const major = topics
  .filter((topic) => topic.communities.length >= rules.classification.majorMinCommunities)
  .sort((a, b) => b.trendScore - a.trendScore)
  .slice(0, rules.classification.maxTopicsPerSection);

const majorNames = new Set(major.map((topic) => topic.topic));
const rising = topics
  .filter((topic) => !majorNames.has(topic.topic) && topic.newestAgeHours <= rules.classification.risingMaxAgeHours)
  .sort((a, b) => b.trendScore - a.trendScore)
  .slice(0, rules.classification.maxTopicsPerSection);

const formatTopic = (entry) => {
  const names = entry.communities.map((id) => communityMap.get(id)?.name ?? id).join(" · ");
  const verification = entry.needsVerification ? " · 사실 확인 필요" : "";
  const urls = entry.items.map((item) => `[${communityMap.get(item.community)?.name ?? item.community}](${item.url})`).join(" · ");
  return `- **${entry.topic}** — ${entry.trendScore.toFixed(1)}점 · ${entry.decision} · ${names} · 댓글 ${entry.totalComments.toLocaleString("ko-KR")}개${verification}\n  - 세부점수: 확산 ${entry.scores.crossCommunityScore.toFixed(0)} · 순위 ${entry.scores.channelRankScore.toFixed(0)} · 댓글/반응률 ${entry.scores.commentsAndEngagementScore.toFixed(0)} · 공감 ${entry.scores.reactionScore.toFixed(0)} · 조회 ${entry.scores.viewScore.toFixed(0)} · 최신성 ${entry.scores.freshnessScore.toFixed(0)}\n  - 원문: ${urls}`;
};

const videoCandidates = [...major, ...rising]
  .sort((a, b) => b.trendScore - a.trendScore)
  .slice(0, 5);

const missing = rules.communities.filter((item) => !seenCommunities.has(item.id)).map((item) => item.name);
const report = [
  `# ${daily.date} 키워드 현황`,
  "",
  `확인 시각: ${daily.checkedAt}`,
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
    ? videoCandidates.map((entry, index) => `${index + 1}. **${entry.topic}** — ${entry.trendScore.toFixed(1)}점 · ${entry.decision} · ${entry.communities.length}개 커뮤니티 · ${entry.needsVerification ? "팩트체크형 권장" : "설명·정리형 권장"}\n   - URL: ${entry.items.map((item) => item.url).join(" · ")}`).join("\n")
    : "- 해당 없음",
  "",
  "## 커뮤니티별 대표 글",
  "",
  ...daily.items.map((item) => `- **${communityMap.get(item.community).name}** — [${item.title}](${item.url})`),
  "",
  "## 미수집 커뮤니티",
  "",
  missing.length ? `- ${missing.join(", ")}` : "- 없음"
].join("\n");

const outputPath = resolve(projectRoot, `reports/${daily.date}.md`);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${report}\n`, "utf8");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const topicCards = (entries, emptyText) => entries.length ? entries.map((entry) => `
  <article class="topic-card">
    <div class="topic-head"><h3>${escapeHtml(entry.topic)} · ${entry.trendScore.toFixed(1)}점</h3>${entry.needsVerification ? '<span class="badge warning">확인 필요</span>' : '<span class="badge">검증 가능</span>'}</div>
    <p>${escapeHtml(entry.decision)} · ${entry.communities.map((id) => escapeHtml(communityMap.get(id)?.name ?? id)).join(" · ")} · 댓글 ${entry.totalComments.toLocaleString("ko-KR")}개</p>
    <p>확산 ${entry.scores.crossCommunityScore.toFixed(0)} · 순위 ${entry.scores.channelRankScore.toFixed(0)} · 댓글/반응 ${entry.scores.commentsAndEngagementScore.toFixed(0)} · 공감 ${entry.scores.reactionScore.toFixed(0)} · 조회 ${entry.scores.viewScore.toFixed(0)} · 최신성 ${entry.scores.freshnessScore.toFixed(0)}</p>
    <div class="links">${entry.items.map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(communityMap.get(item.community)?.name ?? item.community)} 원문</a>`).join("")}</div>
  </article>`).join("") : `<p class="empty">${escapeHtml(emptyText)}</p>`;

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(daily.date)} 키워드 현황</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#697386;--line:#e5e9f2;--hot:#ed4b43;--main:#5c5ce2;--soft:#eef0ff;--warn:#9a5b00}@media(prefers-color-scheme:dark){:root{--bg:#11141b;--panel:#1a1f2a;--text:#eef2ff;--muted:#9aa5ba;--line:#303848;--soft:#292c47;--warn:#ffc266}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}main{max-width:1080px;margin:auto;padding:32px 20px 64px}header{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:24px}h1,h2,h3,p{margin-top:0}h1{margin-bottom:8px}.muted,.topic-card p{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0 30px}.stat,.topic-card,.video,.community-row{background:var(--panel);border:1px solid var(--line);border-radius:14px}.stat{padding:18px}.stat strong{display:block;font-size:28px;margin-top:6px}.section{margin-top:34px}.section-title{display:flex;align-items:center;gap:8px}.dot{width:10px;height:10px;border-radius:50%;background:var(--main)}.dot.hot{background:var(--hot)}.topics{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.topic-card{padding:18px}.topic-head{display:flex;justify-content:space-between;gap:12px}.topic-head h3{margin-bottom:8px}.badge{font-size:12px;background:var(--soft);padding:5px 8px;border-radius:999px;white-space:nowrap}.badge.warning{color:var(--warn)}.links{display:flex;gap:8px;flex-wrap:wrap}.links a,.community-row a{color:var(--main);text-decoration:none}.videos{display:grid;gap:10px}.video{padding:16px;display:grid;grid-template-columns:42px 1fr auto;gap:12px;align-items:center}.rank{font-size:24px;color:var(--main);font-weight:700}.community-list{display:grid;gap:8px}.community-row{padding:13px 15px;display:grid;grid-template-columns:130px 1fr auto;gap:12px}.empty{color:var(--muted)}@media(max-width:680px){header{display:block}.stats,.topics{grid-template-columns:1fr}.video{grid-template-columns:34px 1fr}.video>a{grid-column:2}.community-row{grid-template-columns:1fr}.community-row span{font-size:13px;color:var(--muted)}}
</style></head><body><main>
<header><div><h1>키워드 현황</h1><p class="muted">${escapeHtml(daily.date)} · 매일 오전 11시</p></div><p class="muted">수집 ${daily.items.length}/${rules.communities.length}개 커뮤니티</p></header>
<section class="stats"><div class="stat"><span>뜨는 주제</span><strong>${rising.length}</strong></div><div class="stat"><span>주요 주제</span><strong>${major.length}</strong></div><div class="stat"><span>영상 후보</span><strong>${videoCandidates.length}</strong></div></section>
<section class="section"><h2 class="section-title"><span class="dot hot"></span>뜨는 주제</h2><div class="topics">${topicCards(rising,"해당 없음")}</div></section>
<section class="section"><h2 class="section-title"><span class="dot"></span>주요 주제</h2><div class="topics">${topicCards(major,"해당 없음")}</div></section>
<section class="section"><h2>이번 주 무조건 검토할 영상 소재</h2><div class="videos">${videoCandidates.map((entry,index)=>`<article class="video"><span class="rank">${index+1}</span><div><strong>${escapeHtml(entry.topic)} · ${entry.trendScore.toFixed(1)}점</strong><div class="muted">${escapeHtml(entry.decision)} · ${entry.communities.length}개 커뮤니티 · ${entry.needsVerification?"팩트체크형":"설명·정리형"}</div></div><a href="${escapeHtml(entry.items[0]?.url)}" target="_blank" rel="noreferrer">대표 URL</a></article>`).join("")||'<p class="empty">해당 없음</p>'}</div></section>
<section class="section"><h2>커뮤니티별 대표 글</h2><div class="community-list">${daily.items.map((item)=>`<div class="community-row"><strong>${escapeHtml(communityMap.get(item.community)?.name??item.community)}</strong><span>${escapeHtml(item.title)}</span><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">원문 보기</a></div>`).join("")}</div></section>
<section class="section"><h2>미수집 커뮤니티</h2><p class="muted">${missing.length?escapeHtml(missing.join(", ")):"없음"}</p></section>
</main></body></html>`;

const htmlPath = resolve(projectRoot, `reports/${daily.date}.html`);
await writeFile(htmlPath, html, "utf8");

const reportsDir = resolve(projectRoot, "reports");
const reportFiles = (await readdir(reportsDir))
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/.test(name))
  .sort((a, b) => b.localeCompare(a));
const indexHtml = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>키워드 현황 누적 리포트</title><style>
:root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#697386;--line:#e5e9f2;--accent:#5c5ce2}@media(prefers-color-scheme:dark){:root{--bg:#11141b;--panel:#1a1f2a;--text:#eef2ff;--muted:#9aa5ba;--line:#303848}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}main{max-width:900px;margin:auto;padding:32px 20px 64px}h1{margin-bottom:8px}.muted{color:var(--muted)}.reports{display:grid;gap:10px;margin-top:28px}.report{display:grid;grid-template-columns:120px 1fr auto;gap:16px;align-items:center;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px}.report:first-child{border-color:var(--accent)}.latest{font-size:12px;color:var(--accent)}a{color:var(--accent);text-decoration:none}@media(max-width:560px){.report{grid-template-columns:1fr}.latest{grid-row:1}}
</style></head><body><main><h1>키워드 현황 누적 리포트</h1><p class="muted">최신 리포트가 항상 최상단에 표시됩니다.</p><div class="reports">${reportFiles.map((file,index)=>{const date=file.replace(".html","");return `<article class="report"><strong>${escapeHtml(date)}</strong><span>${index===0?'<span class="latest">최신 리포트</span>':'일일 키워드 현황'}</span><a href="./${escapeHtml(file)}">리포트 열기</a></article>`}).join("")}</div></main></body></html>`;
const indexPath = resolve(reportsDir, "index.html");
await writeFile(indexPath, indexHtml, "utf8");
console.log(`${outputPath}\n${htmlPath}\n${indexPath}`);
