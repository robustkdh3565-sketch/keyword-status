import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactSnapshot } from "./lib/compact-snapshot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotsRoot = resolve(root, "snapshots");
const dates = await readdir(snapshotsRoot).catch(() => []);
let files = 0;
let beforeBytes = 0;
let afterBytes = 0;

for (const date of dates) {
  const directory = resolve(snapshotsRoot, date);
  const names = await readdir(directory).catch(() => []);
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    const path = resolve(directory, name);
    const raw = await readFile(path, "utf8");
    const compact = `${JSON.stringify(compactSnapshot(JSON.parse(raw)))}\n`;
    await writeFile(path, compact, "utf8");
    files += 1;
    beforeBytes += Buffer.byteLength(raw);
    afterBytes += Buffer.byteLength(compact);
  }
}

console.log(`스냅샷 ${files}개 압축 · ${beforeBytes}B → ${afterBytes}B · ${beforeBytes ? Math.round((1 - afterBytes / beforeBytes) * 100) : 0}% 절감`);
