import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pearson, ridgeFit } from "./lib/statistics.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(projectRoot, process.argv.find((arg) => arg.endsWith(".json")) ?? "model/training.json");
const rules = JSON.parse(await readFile(resolve(projectRoot, "config/rules.json"), "utf8"));
const training = JSON.parse(await readFile(inputPath, "utf8"));
const featureNames = ["crossCommunity", "channelRank", "commentsAndEngagement", "reactions", "views", "freshness"];
const dates = new Set(training.rows.map((row) => row.date));
if (dates.size < rules.scoring.initialPeriodDays) {
  console.error(`학습 중단: ${dates.size}일 데이터만 있습니다. 최소 ${rules.scoring.initialPeriodDays}일이 필요합니다.`);
  process.exit(1);
}
const features = training.rows.map((row) => featureNames.map((name) => Number(row.features[name])));
const target = training.rows.map((row) => Number(row.futureCommunityCount24h) + Number(row.survivedNextDay) * 2);
const model = ridgeFit(features, target, rules.scoring.postInitialModel.ridgeAlpha);
const rawWeights = model.coefficients.slice(1).map((value) => Math.max(0, value));
const weightTotal = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
const weights = Object.fromEntries(featureNames.map((name, index) => [name, rawWeights[index] / weightTotal]));
const correlations = Object.fromEntries(featureNames.map((name, index) => [name, pearson(features.map((row) => row[index]), target)]));
const output = { trainedAt: new Date().toISOString(), dates: dates.size, rows: training.rows.length, target: "futureCommunityCount24h + 2*survivedNextDay", correlations, weights, model };
await mkdir(resolve(projectRoot, "model"), { recursive: true });
await writeFile(resolve(projectRoot, "model/weights.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ dates: dates.size, rows: training.rows.length, correlations, weights }, null, 2));
