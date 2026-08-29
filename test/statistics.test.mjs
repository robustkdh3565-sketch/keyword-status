import test from "node:test";
import assert from "node:assert/strict";
import { pearson, ridgeFit } from "../src/lib/statistics.mjs";

test("피어슨 상관계수를 계산한다", () => {
  assert.ok(pearson([1, 2, 3], [2, 4, 6]) > 0.999);
});
test("Ridge 회귀가 유한한 계수를 반환한다", () => {
  const result = ridgeFit([[1, 0], [2, 1], [3, 1], [4, 2]], [1, 2, 3, 4], 1);
  assert.ok(result.coefficients.every(Number.isFinite));
});
