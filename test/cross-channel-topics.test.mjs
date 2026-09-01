import test from "node:test";
import assert from "node:assert/strict";
import { buildCrossChannelTopics } from "../src/lib/cross-channel-topics.mjs";

test("긴 커뮤니티 주제 안의 검색 핵심어를 교차로 찾는다", () => {
  const matches = buildCrossChannelTopics({
    communityTopics: [{ topic: "용혜인 육아휴직한 남편 경력 단절 걱정", items: [{ url: "https://community.example/post" }] }],
    searchEntries: [{ keyword: "육아휴직", source: "Google Trends 한국", url: "https://trends.example/" }]
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, "핵심어 교차");
  assert.equal(matches[0].keyword, "육아휴직");
});

test("한 단어짜리 일반어는 교차 후보에서 제외한다", () => {
  const matches = buildCrossChannelTopics({
    communityTopics: [{ topic: "군사 훈련 일정" }],
    searchEntries: [{ keyword: "훈련", source: "Google Trends 한국" }]
  });
  assert.equal(matches.length, 0);
});
