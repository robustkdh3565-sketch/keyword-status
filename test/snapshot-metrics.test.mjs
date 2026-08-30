import test from "node:test";
import assert from "node:assert/strict";
import { compareSnapshots, postKey } from "../src/lib/snapshot-metrics.mjs";

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

test("제목이나 조회용 쿼리가 달라도 게시물 ID가 같으면 같은 글이다", () => {
  const first = { community: "clien", title: "원래 제목", url: "https://www.clien.net/service/board/park/19255529?od=T33" };
  const changed = { community: "clien", title: "수정된 제목", url: "https://www.clien.net/service/board/park/19255529?po=0" };
  assert.equal(postKey(first), postKey(changed));
});

test("쿼리 파라미터 기반 게시물 ID도 비교 키로 사용한다", () => {
  const first = { community: "82cook", title: "첫 글", url: "https://www.82cook.com/entiz/read.php?bn=15&num=4233269" };
  const changed = { community: "82cook", title: "수정 제목", url: "https://www.82cook.com/entiz/read.php?num=4233269" };
  const other = { community: "82cook", title: "다른 글", url: "https://www.82cook.com/entiz/read.php?num=4233574" };
  assert.equal(postKey(first), postKey(changed));
  assert.notEqual(postKey(first), postKey(other));
});

test("미수집 조회수 null은 실제 0으로 계산하지 않는다", () => {
  const result = compareSnapshots({
    checkedAt: "2026-08-30T15:00:00+09:00",
    items: [{ community: "inven", title: "글", url: "https://example.com/123456", views: null }]
  }, [{
    checkedAt: "2026-08-30T11:00:00+09:00",
    items: [{ community: "inven", title: "글", url: "https://example.com/123456", views: null }]
  }]);
  assert.equal([...result.metrics.values()][0].measured, false);
});
