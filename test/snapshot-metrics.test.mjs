import test from "node:test";
import assert from "node:assert/strict";
import { compareSnapshots } from "../src/lib/snapshot-metrics.mjs";

test("직전 스냅샷 대비 실제 시간당 조회 증가를 계산한다", () => {
  const history = [{
    checkedAt: "2026-08-30T11:00:00+09:00",
    items: [{ community: "bobae", title: "같은 글.jpg", views: 100, comments: 2, reactions: 3, rank: 5 }]
  }];
  const current = {
    checkedAt: "2026-08-30T15:00:00+09:00",
    items: [{ community: "bobae", title: "같은 글", views: 500, comments: 6, reactions: 5, rank: 2 }]
  };
  const result = compareSnapshots(current, history);
  const metric = [...result.metrics.values()][0];
  assert.equal(metric.measured, true);
  assert.equal(metric.viewsDelta, 400);
  assert.equal(metric.viewsPerHour, 100);
  assert.equal(metric.rankChange, 3);
  assert.equal(metric.engagementDelta, 6);
});

test("직전 목록에 없던 글은 신규 진입으로 표시한다", () => {
  const result = compareSnapshots({
    checkedAt: "2026-08-30T15:00:00+09:00",
    items: [{ community: "inven", title: "새 글", views: 10 }]
  }, [{ checkedAt: "2026-08-30T11:00:00+09:00", items: [] }]);
  const metric = [...result.metrics.values()][0];
  assert.equal(metric.isNew, true);
  assert.equal(metric.measured, false);
});
