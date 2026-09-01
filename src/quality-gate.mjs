import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCoreRankings, validateDailyInput, validateRenderedReports, extractCoreRankings } from "./lib/report-quality.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputArg = process.argv.find((arg) => arg.endsWith(".json"));
if (!inputArg) {
  console.error("사용법: npm run quality -- data/YYYY-MM-DD.json");
  process.exit(1);
}
const rules = JSON.parse(await readFile(resolve(projectRoot, "config/rules.json"), "utf8"));
const daily = JSON.parse(await readFile(resolve(projectRoot, inputArg), "utf8"));
const markdown = await readFile(resolve(projectRoot, `reports/${daily.date}.md`), "utf8");
const html = await readFile(resolve(projectRoot, `reports/${daily.date}.html`), "utf8");
const baseline = JSON.parse(await readFile(resolve(projectRoot, `state/quality-baselines/${daily.date}.json`), "utf8"));
const input = validateDailyInput(daily, rules);
const rendered = validateRenderedReports({ markdown, html });
const ranking = validateCoreRankings(extractCoreRankings(markdown), baseline);
for (const warning of input.warnings) console.warn(`주의: ${warning}`);
const errors = [...input.errors, ...rendered.errors, ...ranking.errors];
if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`${daily.date} 품질 게이트 통과 · 게시물 ${daily.items.length}개 · 핵심 순위 기준선 일치`);
