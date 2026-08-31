import test from "node:test";
import assert from "node:assert/strict";
import { buildExpansionThemes, buildWeeklyTopics, canonicalizeKeyword, selectRollingDailies } from "../src/lib/weekly-topics.mjs";

const dailies = [
  { date: "2026-08-22", items: [{ community: "a", topic: "오래된 주제", title: "오래된 주제", url: "old" }] },
  { date: "2026-08-29", research: { "반복 주제": { expandedKeywords: ["관측 연관어"] } }, items: [{ community: "a", topic: "반복 주제", title: "반복 주제 첫 글", url: "a", views: 100, comments: 10 }] },
  { date: "2026-08-30", items: [{ community: "b", topic: "반복 주제", title: "반복 주제 둘째 글", url: "b", views: 200, comments: 20 }, { community: "c", topic: "신규 주제", title: "신규 주제", url: "c", views: 300 }] }
];

test("최근 7일 창만 선택하고 수집 일수를 그대로 표시한다", () => {
  const selected = selectRollingDailies(dailies, "2026-08-30");
  assert.deepEqual(selected.map((daily) => daily.date), ["2026-08-29", "2026-08-30"]);
});

test("여러 날과 커뮤니티에 등장한 주제를 우선한다", () => {
  const weekly = buildWeeklyTopics({ dailies, reportDate: "2026-08-30", communityGroups: { a: "x", b: "y", c: "z" } });
  assert.equal(weekly.collectedDays, 2);
  assert.equal(weekly.topics[0].canonical, "반복 주제");
  assert.equal(weekly.topics[0].eligible, true);
  assert.equal(weekly.topics[0].dates.length, 2);
  assert.equal(weekly.topics.find((entry) => entry.canonical === "신규 주제").status, "이번 주 신규");
  assert.equal(weekly.major.length, 1);
  assert.equal(weekly.candidates.length, 1);
});

test("기사형 제목을 짧은 표준 키워드로 정리한다", () => {
  assert.equal(canonicalizeKeyword("단독 배우 이용주 29일 별세... 향년 44세"), "배우 이용주 별세");
});

test("관측된 확장어와 아이디어 후보를 구분한다", () => {
  const weekly = buildWeeklyTopics({ dailies, reportDate: "2026-08-30" });
  const expansions = buildExpansionThemes({ weekly, dailies });
  assert.equal(expansions[0].observed[0].keyword, "관측 연관어");
  assert.equal(expansions[0].observed[0].source, "외부 리서치");
  assert.equal(expansions[0].angles.length, 3);
});

test("복제 제목의 조회수는 중복 보정값에서 가장 큰 값만 사용한다", () => {
  const weekly = buildWeeklyTopics({ dailies: [{ date: "2026-08-30", items: [
    { community: "a", topic: "같은 사건", title: "같은 사건 원문", url: "a", views: 100 },
    { community: "b", topic: "같은 사건", title: "같은 사건 원문", url: "b", views: 300 },
    { community: "c", topic: "같은 사건", title: "같은 사건 후속", url: "c", views: 50 }
  ] }], reportDate: "2026-08-30" });
  assert.equal(weekly.major[0].totalViews, 450);
  assert.equal(weekly.major[0].independentViews, 350);
});
