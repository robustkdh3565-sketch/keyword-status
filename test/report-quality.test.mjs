import test from "node:test";
import assert from "node:assert/strict";
import { extractCoreRankings, validateAnalysis, validateCoreRankings, validateDailyInput, validateRenderedReports } from "../src/lib/report-quality.mjs";

const rules = { communities: [{ id: "a", name: "A" }, { id: "b", name: "B" }], normalization: {} };

test("잘못된 URL과 중복 URL을 입력 오류로 처리한다", () => {
  const result = validateDailyInput({ date: "2026-09-01", checkedAt: "2026-09-01T11:00:00+09:00", items: [
    { community: "a", title: "정상 제목", publishedAt: "2026-09-01T10:00:00+09:00", url: "https://example.com/a" },
    { community: "a", title: "중복 제목", publishedAt: "2026-09-01T10:00:00+09:00", url: "https://example.com/a" },
    { community: "a", title: "깨진 주소", publishedAt: "2026-09-01T10:00:00+09:00", url: "not-a-url" }
  ] }, rules);
  assert.ok(result.errors.some((error) => error.includes("중복")));
  assert.ok(result.errors.some((error) => error.includes("http/https")));
});

test("누락 커뮤니티와 표본 부족을 경고한다", () => {
  const result = validateDailyInput({ date: "2026-09-01", checkedAt: "2026-09-01T11:00:00+09:00", items: [
    { community: "a", title: "정상 제목", publishedAt: "2026-09-01T10:00:00+09:00", url: "https://example.com/a" }
  ] }, rules);
  assert.ok(result.warnings.some((warning) => warning.includes("미수집 커뮤니티: B")));
  assert.ok(result.warnings.some((warning) => warning.includes("A 1건")));
});

test("주간 주요와 관찰 후보의 topic ID 중복을 막는다", () => {
  const result = validateAnalysis({ weekly: { major: [{ topicId: "same", canonical: "정상 주제" }], candidates: [{ topicId: "same", canonical: "다른 주제" }] }, expansions: [], crossChannelTopics: [] });
  assert.ok(result.errors.some((error) => error.includes("같은 topic ID")));
});

test("교차 키워드에는 양쪽 근거 URL이 필요하다", () => {
  const result = validateAnalysis({ weekly: { major: [], candidates: [] }, expansions: [], crossChannelTopics: [{ keyword: "육아휴직", type: "핵심어 교차", reason: "포함", communityUrls: [] }] });
  assert.equal(result.errors.length, 2);
});

test("생성물의 금지값과 빈 제목·링크를 차단한다", () => {
  const result = validateRenderedReports({ markdown: "## \nNaN", html: '<h3></h3><a href="">x</a>' });
  assert.ok(result.errors.length >= 4);
});

test("핵심 순위를 추출하고 기준선 변화는 실패시킨다", () => {
  const markdown = "## 뜨는 주제\n\n- **주제 A** — 70.0점\n\n## 주요 주제\n\n- **주제 B** — 80.0점\n\n## 이번 주 영상 소재\n\n1. **주제 C** — 90.0점";
  const current = extractCoreRankings(markdown);
  assert.equal(current.rising[0].title, "주제 A");
  assert.equal(validateCoreRankings(current, current).errors.length, 0);
  assert.equal(validateCoreRankings(current, { ...current, videos: [] }).errors.length, 1);
});
