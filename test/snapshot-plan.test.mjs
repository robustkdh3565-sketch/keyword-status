import test from "node:test";
import assert from "node:assert/strict";
import { selectMoamoaCommunities, shouldCollectSocialSource, todayBestCommunityIds } from "../src/lib/snapshot-plan.mjs";

const rules = {
  communities: [
    { id: "bobae", sources: ["moamoa", "todayBest"] },
    { id: "todayhumor", sources: ["moamoa"] },
    { id: "humoruniv", sources: ["moamoa"] },
    { id: "theqoo", sources: ["todayBest"] }
  ]
};

test("snapshot-only에서는 todayBest로 커버되지 않은 moamoa 커뮤니티만 호출한다", () => {
  const result = selectMoamoaCommunities({
    snapshotOnly: true,
    rules,
    collectedCommunityIds: new Set(["bobae"]),
    todayBestIds: new Set(["bobae"])
  });
  assert.deepEqual(result, ["todayhumor", "humoruniv"]);
});

test("snapshot-only에서도 todayBest에서 비어 있던 공유 커뮤니티는 moamoa로 보충한다", () => {
  const result = selectMoamoaCommunities({
    snapshotOnly: true,
    rules,
    collectedCommunityIds: new Set(),
    todayBestIds: new Set(["bobae"])
  });
  assert.deepEqual(result, ["bobae", "todayhumor", "humoruniv"]);
});

test("full collect에서는 기존처럼 모든 moamoa 커뮤니티를 호출한다", () => {
  const result = selectMoamoaCommunities({
    snapshotOnly: false,
    rules,
    collectedCommunityIds: new Set(["bobae"]),
    todayBestIds: new Set(["bobae"])
  });
  assert.deepEqual(result, ["bobae", "todayhumor", "humoruniv"]);
});

test("snapshot-only에서는 googleTrends만 외부 채널 수집을 유지한다", () => {
  assert.equal(shouldCollectSocialSource({ snapshotOnly: true, source: "googleTrends" }), true);
  assert.equal(shouldCollectSocialSource({ snapshotOnly: true, source: "youtube" }), false);
  assert.equal(shouldCollectSocialSource({ snapshotOnly: true, source: "x" }), false);
});

test("todayBest 커뮤니티 집합을 만든다", () => {
  assert.deepEqual([...todayBestCommunityIds({ BOB: "bobae", QOO: "theqoo" })].sort(), ["bobae", "theqoo"]);
});
