import { readFile, writeFile, mkdir } from "node:fs/promises";
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
const groups = new Map();
for (const item of daily.items) {
  const group = groups.get(item.topic) ?? [];
  group.push(item);
  groups.set(item.topic, group);
}

const topics = [...groups.entries()].map(([topic, items]) => {
  const newestAgeHours = Math.min(...items.map((item) => (checkedAt - new Date(item.publishedAt)) / 3_600_000));
  const communities = [...new Set(items.map((item) => item.community))];
  return {
    topic,
    items,
    communities,
    newestAgeHours,
    totalComments: items.reduce((sum, item) => sum + Number(item.comments || 0), 0),
    totalViews: items.reduce((sum, item) => sum + Number(item.views || 0), 0),
    needsVerification: items.some((item) => item.needsVerification)
  };
});

const major = topics
  .filter((topic) => topic.communities.length >= rules.classification.majorMinCommunities)
  .sort((a, b) => b.communities.length - a.communities.length || b.totalComments - a.totalComments)
  .slice(0, rules.classification.maxTopicsPerSection);

const majorNames = new Set(major.map((topic) => topic.topic));
const rising = topics
  .filter((topic) => !majorNames.has(topic.topic) && topic.newestAgeHours <= rules.classification.risingMaxAgeHours)
  .sort((a, b) => b.totalComments - a.totalComments || b.totalViews - a.totalViews)
  .slice(0, rules.classification.maxTopicsPerSection);

const formatTopic = (entry) => {
  const names = entry.communities.map((id) => communityMap.get(id)?.name ?? id).join(" · ");
  const verification = entry.needsVerification ? " · 사실 확인 필요" : "";
  return `- **${entry.topic}** — ${names} · 댓글 ${entry.totalComments.toLocaleString("ko-KR")}개${verification}`;
};

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
console.log(outputPath);
