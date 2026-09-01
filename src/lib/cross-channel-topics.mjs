import { jaccardSimilarity, normalizeTitle, tokenSet } from "./topic-normalizer.mjs";

const genericSingleTerms = new Set(["훈련", "시장", "사건", "논란", "여행", "가격", "뉴스", "영상"]);

function matchLevel(communityTopic, channelKeyword, normalization = {}) {
  const left = normalizeTitle(communityTopic, normalization).toLowerCase();
  const right = normalizeTitle(channelKeyword, normalization).toLowerCase();
  if (!left || !right) return null;
  if (left === right) return { type: "확정 교차", reason: "표준 키워드 완전 일치" };
  const keywordTokens = [...tokenSet(right, normalization)];
  if (right.length >= 3 && !genericSingleTerms.has(right) && (left.includes(right) || (keywordTokens.length <= 3 && keywordTokens.every((token) => left.includes(token))))) {
    return { type: "핵심어 교차", reason: "채널 키워드가 커뮤니티 주제에 포함" };
  }
  const common = keywordTokens.filter((token) => tokenSet(left, normalization).has(token)).length;
  if (common >= 2 && jaccardSimilarity(left, right, normalization) >= 0.6) return { type: "유사 교차 후보", reason: "복수 핵심어 유사" };
  return null;
}

export function buildCrossChannelTopics({ communityTopics = [], searchEntries = [], socialEntries = [], normalization = {} }) {
  const channels = [
    ...searchEntries.map((entry) => ({ ...entry, channel: "검색" })),
    ...socialEntries.map((entry) => ({ ...entry, channel: "SNS" }))
  ];
  const matches = [];
  for (const community of communityTopics) for (const channel of channels) {
    const match = matchLevel(community.topic, channel.keyword, normalization);
    if (!match) continue;
    matches.push({
      keyword: channel.keyword,
      communityTopic: community.topic,
      channels: ["커뮤니티", channel.channel],
      source: channel.source,
      channelUrl: channel.url,
      communityUrls: [...new Set((community.items ?? []).map((item) => item.url).filter(Boolean))].slice(0, 3),
      ...match
    });
  }
  const order = { "확정 교차": 0, "핵심어 교차": 1, "유사 교차 후보": 2 };
  return matches.sort((a, b) => order[a.type] - order[b.type]);
}
