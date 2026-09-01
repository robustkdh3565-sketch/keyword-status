import { normalizeTitle } from "./topic-normalizer.mjs";

const validHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export function isMeaningfulKeyword(value, normalization = {}) {
  const normalized = normalizeTitle(value, normalization);
  return Boolean(normalized && /[가-힣A-Za-z0-9]{2,}/.test(normalized));
}

export function validateDailyInput(daily, rules) {
  const errors = [];
  const warnings = [];
  const knownCommunities = new Set((rules.communities ?? []).map((community) => community.id));
  const counts = new Map((rules.communities ?? []).map((community) => [community.id, 0]));
  const urls = new Set();

  if (!daily?.date || !daily?.checkedAt || !Array.isArray(daily?.items)) errors.push("date, checkedAt, items 필드가 필요합니다.");
  for (const [index, item] of (daily?.items ?? []).entries()) {
    if (!knownCommunities.has(item.community)) errors.push(`${index + 1}번 항목의 community가 올바르지 않습니다.`);
    counts.set(item.community, (counts.get(item.community) ?? 0) + 1);
    if (!item.title) errors.push(`${index + 1}번 항목에 title이 없습니다.`);
    if (!item.publishedAt) errors.push(`${index + 1}번 항목에 publishedAt이 없습니다.`);
    if (!validHttpUrl(item.url)) errors.push(`${index + 1}번 항목의 URL이 올바른 http/https 주소가 아닙니다.`);
    else if (urls.has(item.url)) errors.push(`${index + 1}번 항목의 URL이 중복되었습니다: ${item.url}`);
    else urls.add(item.url);
  }
  for (const channel of [...(daily?.channels?.search ?? []), ...(daily?.channels?.social ?? [])]) {
    if (!isMeaningfulKeyword(channel.keyword, rules.normalization)) errors.push(`채널 키워드가 비어 있거나 의미가 없습니다: ${channel.keyword ?? "미수집"}`);
    if (channel.url && !validHttpUrl(channel.url)) errors.push(`채널 URL이 올바른 http/https 주소가 아닙니다: ${channel.url}`);
  }
  const missing = (rules.communities ?? []).filter((community) => (counts.get(community.id) ?? 0) === 0);
  const low = (rules.communities ?? []).filter((community) => {
    const count = counts.get(community.id) ?? 0;
    return count > 0 && count < 3;
  });
  if (missing.length) warnings.push(`미수집 커뮤니티: ${missing.map((community) => community.name).join(" · ")}`);
  if (low.length) warnings.push(`표본 3건 미만: ${low.map((community) => `${community.name} ${counts.get(community.id)}건`).join(" · ")}`);
  return { errors, warnings, counts };
}

export function validateAnalysis({ weekly, expansions, crossChannelTopics, normalization = {} }) {
  const errors = [];
  const majorIds = new Set((weekly?.major ?? []).map((entry) => entry.topicId));
  for (const entry of [...(weekly?.major ?? []), ...(weekly?.candidates ?? [])]) {
    if (!isMeaningfulKeyword(entry.canonical, normalization)) errors.push(`주간 키워드가 비어 있거나 의미가 없습니다: ${entry.topicId ?? "ID 없음"}`);
  }
  for (const entry of weekly?.candidates ?? []) if (majorIds.has(entry.topicId)) errors.push(`주간 주요와 관찰 후보에 같은 topic ID가 있습니다: ${entry.topicId}`);
  for (const expansion of expansions ?? []) {
    if (!Array.isArray(expansion.observed) || !Array.isArray(expansion.angles)) errors.push(`관측 키워드와 콘텐츠 각도가 분리되지 않았습니다: ${expansion.topic}`);
    const observed = new Set((expansion.observed ?? []).map((entry) => normalizeTitle(entry.keyword, normalization)));
    for (const angle of expansion.angles ?? []) if (observed.has(normalizeTitle(angle.name, normalization))) errors.push(`관측 키워드가 콘텐츠 각도와 중복됩니다: ${angle.name}`);
  }
  for (const entry of crossChannelTopics ?? []) {
    if (!entry.type || !entry.reason) errors.push(`교차 키워드 판정 근거가 없습니다: ${entry.keyword}`);
    if (!entry.channelUrl || !validHttpUrl(entry.channelUrl)) errors.push(`교차 키워드 채널 URL이 없습니다: ${entry.keyword}`);
    if (!entry.communityUrls?.length || entry.communityUrls.some((url) => !validHttpUrl(url))) errors.push(`교차 키워드 커뮤니티 URL이 없습니다: ${entry.keyword}`);
  }
  return { errors };
}

export function validateRenderedReports({ markdown, html }) {
  const errors = [];
  for (const [name, value] of [["Markdown", markdown], ["HTML", html]]) {
    if (/\b(?:NaN|undefined|Infinity)\b/.test(value)) errors.push(`${name}에 금지값이 포함되어 있습니다.`);
  }
  if (/\*\*\s*\*\*/.test(markdown) || /^#{1,6}\s*$/m.test(markdown)) errors.push("Markdown에 빈 제목이 있습니다.");
  if (/<h[1-6][^>]*>\s*(?:<[^>]+>\s*)*<\/h[1-6]>/i.test(html)) errors.push("HTML에 빈 제목이 있습니다.");
  if (/href\s*=\s*["']\s*["']/i.test(html)) errors.push("HTML에 빈 링크가 있습니다.");
  return { errors };
}

export function extractCoreRankings(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const extract = (heading, pattern) => {
    const start = lines.indexOf(`## ${heading}`);
    if (start < 0) return [];
    const result = [];
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith("## ")) break;
      const match = line.match(pattern);
      if (match) result.push({ title: match[1], score: Number(match[2]) });
    }
    return result;
  };
  return {
    rising: extract("뜨는 주제", /^- \*\*(.+?)\*\* — ([\d.]+)점/),
    major: extract("주요 주제", /^- \*\*(.+?)\*\* — ([\d.]+)점/),
    videos: extract("이번 주 영상 소재", /^\d+\. \*\*(.+?)\*\* — ([\d.]+)점/)
  };
}

export function validateCoreRankings(current, baseline) {
  return JSON.stringify(current) === JSON.stringify(baseline)
    ? { errors: [] }
    : { errors: ["뜨는 주제·주요 주제·영상 후보의 제목·순위·점수가 기준선과 달라졌습니다."] };
}
