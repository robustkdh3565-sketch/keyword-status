import test from "node:test";
import assert from "node:assert/strict";
import { compactSnapshot, snapshotFileName } from "../src/lib/compact-snapshot.mjs";

test("스냅샷에서 비교에 필요 없는 중복 관측값을 제거한다", () => {
  const result = compactSnapshot({
    date: "2026-08-30",
    checkedAt: "2026-08-30T15:00:00+09:00",
    items: [{
      community: "bobae",
      topic: "글",
      normalizedTitle: "글",
      title: "글",
      url: "https://example.com/123456",
      views: 10,
      sourceRanks: [{ source: "todayBest", rank: 1 }],
      sourceObservations: [{ large: "duplicate" }],
      comparison: { measured: true }
    }]
  });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.items[0].views, 10);
  assert.equal("sourceObservations" in result.items[0], false);
  assert.deepEqual(result.items[0].sourceRanks, [{ source: "todayBest", rank: 1 }]);
  assert.deepEqual(result.items[0].comparison, { measured: true });
  assert.equal(result.items[0].normalizedTitle, "글");
});

test("자동 실행 재시도는 같은 시간대 슬롯 파일을 사용한다", () => {
  const times = ["11:00", "15:00", "19:00"];
  assert.equal(snapshotFileName("2026-08-30T15:03:11+09:00", times), "150000.json");
  assert.equal(snapshotFileName("2026-08-30T15:49:59+09:00", times), "150000.json");
  assert.equal(snapshotFileName("2026-08-30T12:24:42+09:00", times), "122442.json");
});
