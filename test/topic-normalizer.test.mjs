import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTitle, jaccardSimilarity, clusterItems } from "../src/lib/topic-normalizer.mjs";

const options = { stopwords: ["근황", "논란", "충격"], similarityThreshold: 0.5 };
test("제목 장식과 불용어를 제거한다", () => {
  assert.equal(normalizeTitle("1 충격) 새벽배송 제한 근황 ㅋㅋㅋ.jpg", options), "새벽배송 제한");
});
test("유사 주제의 토큰 겹침을 계산한다", () => {
  assert.ok(jaccardSimilarity("새벽배송 제한 추진", "새벽배송 제한 업계 반발", options) >= 0.5);
});
test("유사 제목을 같은 토픽으로 묶는다", () => {
  const clustered = clusterItems([{ title: "새벽배송 제한 추진" }, { title: "새벽배송 제한 업계 반발" }], options);
  assert.equal(clustered[0].topic, clustered[1].topic);
});
test("사람이 확정한 서로 다른 토픽은 퍼지 병합하지 않는다", () => {
  const clustered = clusterItems([
    { title: "미국 이민 이야기", topic: "미국 이민 현실" },
    { title: "미국 모텔 이야기", topic: "미국 모텔 운영 현실" }
  ], options);
  assert.notEqual(clustered[0].topic, clustered[1].topic);
});
