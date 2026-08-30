import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSnapshots, postKey } from "./lib/snapshot-metrics.mjs";
import { compactItem, compactSnapshot, snapshotFileName } from "./lib/compact-snapshot.mjs";
import { selectMoamoaCommunities, shouldCollectSocialSource, todayBestCommunityIds } from "./lib/snapshot-plan.mjs";
import { normalizeTitle } from "./lib/topic-normalizer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotOnly = process.argv.includes("--snapshot-only");
const rules = JSON.parse(await readFile(resolve(root, "config/rules.json"), "utf8"));
const channelConfig = JSON.parse(await readFile(resolve(root, "config/channels.json"), "utf8"));
const now = new Date();
const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: rules.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).formatToParts(now);
const value = (type) => parts.find((part) => part.type === type)?.value;
const date = `${value("year")}-${value("month")}-${value("day")}`;
const checkedAt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: rules.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
}).format(now).replace(" ", "T") + "+09:00";

const communityIds = new Set(rules.communities.map((community) => community.id));
const lowCostSnapshotMode = snapshotOnly;
const todayBestMap = {
  "82C": "82cook",
  ARC: "arca",
  BOB: "bobae",
  CLI: "clien",
  DCI: "dcinside",
  DDA: "ddanzi",
  DOG: "dogdrip",
  ETO: "etoland",
  FMK: "fmkorea",
  GAS: "gasengi",
  INS: "instiz",
  INV: "inven",
  MLB: "mlbpark",
  NAT: "natepann",
  PPO: "ppomppu",
  QOO: "theqoo",
  RUL: "ruliweb",
  YGO: "ygosu"
};

const finiteNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const optionalNumber = (value) => finiteNumber(value) ? Number(value) : null;
const nonEmpty = (value) => value === null || value === undefined || value === "" ? null : String(value);
const topicFromTitle = (title) => String(title)
  .replace(/\.(jpg|jpeg|png|gif|mp4)\b/gi, "")
  .replace(/^\s*(실시간|충격|현재|속보|혐주의)[)\]\s:.-]*/gi, "")
  .replace(/\s*[ㅋㅎㄷ]{2,}\s*$/g, "")
  .trim();
const byBestRank = (left, right) => {
  const leftRank = Math.min(...(left.sourceRanks ?? [{ rank: 99 }]).map((entry) => Number(entry.rank ?? 99)));
  const rightRank = Math.min(...(right.sourceRanks ?? [{ rank: 99 }]).map((entry) => Number(entry.rank ?? 99)));
  if (leftRank !== rightRank) return leftRank - rightRank;
  return (Number(right.views ?? -1) - Number(left.views ?? -1));
};

function mergeObservation(existing, incoming) {
  const observations = [...(existing.sourceObservations ?? [])];
  const duplicateIndex = observations.findIndex((entry) => entry.source === incoming.source && entry.sourceRank === incoming.sourceRank);
  if (duplicateIndex >= 0) {
    observations[duplicateIndex] = { ...observations[duplicateIndex], ...incoming };
  } else {
    observations.push(incoming);
  }
  const sourceRanks = observations
    .map((entry) => ({ source: entry.source, rank: entry.sourceRank }))
    .sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source));
  const preferred = [...observations].sort((a, b) => a.sourceRank - b.sourceRank || Number(b.views ?? -1) - Number(a.views ?? -1))[0];
  return {
    ...existing,
    topic: existing.topic || incoming.topic,
    title: existing.title || incoming.title,
    url: existing.url || incoming.url,
    publishedAt: existing.publishedAt || incoming.publishedAt,
    publishedAtSource: existing.publishedAtSource || incoming.publishedAtSource,
    views: existing.views ?? incoming.views,
    comments: existing.comments ?? incoming.comments,
    reactions: existing.reactions ?? incoming.reactions,
    source: preferred?.source ?? existing.source ?? incoming.source,
    sourceRanks,
    sourceObservations: observations
  };
}

const itemsByCommunity = new Map();
function add(item) {
  if (!communityIds.has(item.community) || !item.url) return;
  const normalizedTitle = normalizeTitle(item.title, rules.normalization) || String(item.title ?? "").normalize("NFKC").trim();
  const incoming = {
    ...item,
    normalizedTitle,
    topic: nonEmpty(item.topic) ?? normalizedTitle,
    title: nonEmpty(item.title),
    url: nonEmpty(item.url),
    publishedAt: nonEmpty(item.publishedAt) ?? checkedAt,
    publishedAtSource: nonEmpty(item.publishedAtSource) ?? "estimated",
    views: optionalNumber(item.views),
    comments: optionalNumber(item.comments),
    reactions: optionalNumber(item.reactions),
    sourceRank: Number(item.sourceRank ?? item.rank ?? 99),
    sourceObservationCheckedAt: checkedAt
  };
  const list = itemsByCommunity.get(incoming.community) ?? [];
  const index = list.findIndex((existing) => existing.url === incoming.url || (
    existing.normalizedTitle === incoming.normalizedTitle &&
    existing.publishedAt === incoming.publishedAt
  ));
  if (index >= 0) {
    list[index] = mergeObservation(list[index], {
      source: incoming.source,
      sourceRank: incoming.sourceRank,
      title: incoming.title,
      url: incoming.url,
      publishedAt: incoming.publishedAt,
      publishedAtSource: incoming.publishedAtSource,
      views: incoming.views,
      comments: incoming.comments,
      reactions: incoming.reactions,
      checkedAt
    });
  } else {
    list.push({
      community: incoming.community,
      topic: incoming.topic,
      normalizedTitle: incoming.normalizedTitle,
      title: incoming.title,
      url: incoming.url,
      publishedAt: incoming.publishedAt,
      publishedAtSource: incoming.publishedAtSource,
      views: incoming.views,
      comments: incoming.comments,
      reactions: incoming.reactions,
      rank: incoming.rank,
      candidateCount: incoming.candidateCount,
      source: incoming.source,
      needsVerification: item.needsVerification ?? true,
      sourceRanks: [{ source: incoming.source, rank: incoming.sourceRank }],
      sourceObservations: [{
        source: incoming.source,
        sourceRank: incoming.sourceRank,
        title: incoming.title,
        url: incoming.url,
        publishedAt: incoming.publishedAt,
        publishedAtSource: incoming.publishedAtSource,
        views: incoming.views,
        comments: incoming.comments,
        reactions: incoming.reactions,
        checkedAt
      }]
    });
  }
  itemsByCommunity.set(incoming.community, list);
}

const collectionStatus = {
  community: { status: "collecting", providers: ["todayBest", "moamoa"] },
  search: { status: "collecting", providers: ["googleTrends"] },
  youtube: { status: "pending", providers: ["youtube"] },
  x: { status: "pending", providers: ["x"] },
  disabledSources: channelConfig.disabledSources ?? [],
  mode: lowCostSnapshotMode ? "snapshot-only-low-cost" : "full-collect"
};

const groupedUrl = `https://todaybeststory.com/api/v2/communities/posts/grouped-best?startDate=${date}&endDate=${date}&topN=10`;
const grouped = await fetch(groupedUrl).then((response) => {
  if (!response.ok) throw new Error(`오늘의베스트 ${response.status}`);
  return response.json();
});
for (const community of grouped.communities ?? []) {
  const id = todayBestMap[community.communityId];
  if (!id) continue;
  (community.posts ?? []).slice(0, 10).forEach((post, index) => {
    const views = Number(post.readCount) === 0 && (Number(post.commentCount ?? 0) > 0 || Number(post.upvoteCount ?? 0) > 0)
      ? null
      : post.readCount;
    add({
    community: id,
    topic: topicFromTitle(post.postTitle),
    title: post.postTitle,
    url: post.postUrl,
    publishedAt: post.postDatetime ?? checkedAt,
    publishedAtSource: post.postDatetime ? "source" : "estimated",
    views,
    comments: post.commentCount,
    reactions: post.upvoteCount,
    rank: index + 1,
    sourceRank: index + 1,
    candidateCount: Math.min(10, community.posts.length),
    source: "todayBest",
    needsVerification: true
  });
  });
}

const moamoaIds = selectMoamoaCommunities({
  snapshotOnly: lowCostSnapshotMode,
  rules,
  collectedCommunityIds: new Set(itemsByCommunity.keys()),
  todayBestIds: todayBestCommunityIds(todayBestMap)
});
for (const id of moamoaIds) {
  try {
    const posts = await fetch(`https://moamoa.kr/api?scope=24&sort=popular&sites=${id}`).then((response) => {
      if (!response.ok) throw new Error(`모아모아 ${response.status}`);
      return response.json();
    });
    posts.slice(0, 10).forEach((post, index) => {
      const views = optionalNumber(post.views);
      const point = optionalNumber(post.point);
      add({
        community: id,
        topic: topicFromTitle(post.title),
        title: post.title,
        url: post.url ?? ({
          bobae: `https://www.bobaedream.co.kr/view?code=strange&No=${post.id}`,
          inven: `https://www.inven.co.kr/board/webzine/2097/${post.id}`,
          ddanzi: `https://www.ddanzi.com/free/${post.id}`,
          clien: `https://www.clien.net/service/board/park/${post.id}`,
          mlbpark: `https://mlbpark.donga.com/mp/b.php?b=bullpen&id=${post.id}`,
          ruliweb: `https://bbs.ruliweb.com/community/board/300143/read/${post.id}`,
          todayhumor: `https://www.todayhumor.co.kr/board/view.php?table=humorbest&no=${post.id}`,
          humoruniv: `https://web.humoruniv.com/board/humor/read.html?table=pdswait&number=${post.id}`,
          "82cook": `https://www.82cook.com/entiz/read.php?bn=15&num=${post.id}`
        })[id],
        publishedAt: post.date ?? checkedAt,
        publishedAtSource: post.date ? "source" : "estimated",
        views,
        comments: post.comments,
        reactions: point !== null && views !== null ? Math.max(0, point - views) : null,
        rank: index + 1,
        sourceRank: index + 1,
        candidateCount: Math.min(10, posts.length),
        source: "moamoa",
        needsVerification: true
      });
    });
  } catch (error) {
    console.warn(`모아모아 ${id}: ${error.message}`);
  }
}
collectionStatus.community = {
  status: "collected",
  providers: ["todayBest", ...(moamoaIds.length ? ["moamoa"] : [])],
  communityCount: itemsByCommunity.size,
  moamoaRequests: moamoaIds.length
};

function extractJsonBlock(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const begin = start + marker.length;
  const end = html.indexOf(";</script>", begin);
  if (end < 0) return null;
  return html.slice(begin, end).trim();
}

function findObjects(rootValue, key) {
  const results = [];
  const queue = [rootValue];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    if (key in value) results.push(value[key]);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return results;
}

function parseCompactCount(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/\s+/g, "");
  const direct = text.match(/([\d,]+)/);
  if (direct && !/[만억천KMB]/i.test(text)) return Number(direct[1].replaceAll(",", ""));
  const numeric = Number((text.match(/[\d.]+/)?.[0]) ?? NaN);
  if (!Number.isFinite(numeric)) return null;
  if (text.includes("억")) return Math.round(numeric * 100000000);
  if (text.includes("만")) return Math.round(numeric * 10000);
  if (text.includes("천")) return Math.round(numeric * 1000);
  if (/m/i.test(text)) return Math.round(numeric * 1000000);
  if (/k/i.test(text)) return Math.round(numeric * 1000);
  return Math.round(numeric);
}

async function collectYoutubeTrending() {
  const response = await fetch("https://www.youtube.com/feed/trending?bp=6gQJRkVleHBsb3Jl&hl=ko&gl=KR", {
    headers: { "accept-language": "ko-KR,ko;q=0.9,en;q=0.8", "user-agent": "Mozilla/5.0" }
  });
  if (!response.ok) throw new Error(`YouTube ${response.status}`);
  const html = await response.text();
  const payload = extractJsonBlock(html, "var ytInitialData = ");
  if (!payload) throw new Error("YouTube 초기 데이터 파싱 실패");
  const data = JSON.parse(payload);
  const renderers = findObjects(data, "videoRenderer")
    .filter(Boolean)
    .filter((entry) => entry.videoId && entry.title);
  const seen = new Set();
  const items = [];
  for (const renderer of renderers) {
    if (seen.has(renderer.videoId)) continue;
    seen.add(renderer.videoId);
    const title = renderer.title?.runs?.map((part) => part.text).join("") ?? renderer.title?.simpleText;
    if (!title) continue;
    const viewsText = renderer.viewCountText?.simpleText ?? renderer.shortViewCountText?.simpleText ?? null;
    const publishedText = renderer.publishedTimeText?.simpleText ?? null;
    items.push({
      rank: items.length + 1,
      keyword: title,
      normalizedTitle: normalizeTitle(title, rules.normalization) || title,
      source: "YouTube 한국",
      sourceType: "youtube",
      metric: [`인기 ${items.length + 1}위`, viewsText ? `조회 ${viewsText}` : null, publishedText].filter(Boolean).join(" · "),
      url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
      views: parseCompactCount(viewsText),
      comments: null,
      reactions: null,
      publishedAt: null,
      publishedAtSource: publishedText ? "relativeText" : "uncollected"
    });
    if (items.length === 10) break;
  }
  if (!items.length) throw new Error("YouTube 인기 영상이 비어 있습니다");
  return items;
}

async function collectXTrending() {
  throw new Error("X 한국 실시간 트렌드는 인증 없는 안정적 공개 소스가 없어 자동 수집을 보류합니다");
}

const rss = await fetch("https://trends.google.com/trending/rss?geo=KR").then((response) => {
  if (!response.ok) throw new Error(`Google Trends ${response.status}`);
  return response.text();
});
const searchEntries = [...rss.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<ht:approx_traffic>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/ht:approx_traffic>[\s\S]*?<\/item>/g)]
  .slice(0, 10)
  .map((match, index) => ({
    rank: index + 1,
    keyword: match[1],
    normalizedTitle: normalizeTitle(match[1], rules.normalization) || match[1],
    source: "Google Trends 한국",
    sourceType: "googleTrends",
    metric: `급상승 검색 ${match[2]}`,
    url: `https://trends.google.com/trends/explore?date=now%201-d&geo=KR&q=${encodeURIComponent(match[1])}`,
    sourceRank: index + 1
  }));
collectionStatus.search = { status: "collected", providers: ["googleTrends"], count: searchEntries.length };

let youtubeEntries = [];
if (shouldCollectSocialSource({ snapshotOnly: lowCostSnapshotMode, source: "youtube" })) {
  try {
    youtubeEntries = await collectYoutubeTrending();
    collectionStatus.youtube = { status: "collected", providers: ["youtube"], count: youtubeEntries.length };
  } catch (error) {
    collectionStatus.youtube = { status: "uncollected", providers: ["youtube"], reason: error.message };
    console.warn(`YouTube: ${error.message}`);
  }
} else {
  collectionStatus.youtube = { status: "skipped", providers: ["youtube"], reason: "snapshot-only 저비용 모드에서는 YouTube를 수집하지 않습니다" };
}

let xEntries = [];
if (shouldCollectSocialSource({ snapshotOnly: lowCostSnapshotMode, source: "x" })) {
  try {
    xEntries = await collectXTrending();
    collectionStatus.x = { status: "collected", providers: ["x"], count: xEntries.length };
  } catch (error) {
    collectionStatus.x = { status: "uncollected", providers: ["x"], reason: error.message };
    console.warn(`X: ${error.message}`);
  }
} else {
  collectionStatus.x = { status: "skipped", providers: ["x"], reason: "snapshot-only 저비용 모드에서는 X를 수집하지 않습니다" };
}

const items = [...itemsByCommunity.entries()].flatMap(([community, posts]) => {
  const selected = [...posts].sort(byBestRank).slice(0, 10);
  return selected.map((post, index) => ({
    ...post,
    community,
    rank: index + 1,
    candidateCount: selected.length
  }));
});

const snapshotDirectory = resolve(root, "snapshots", date);
const snapshotFiles = await readdir(snapshotDirectory).catch(() => []);
const history = await Promise.all(snapshotFiles
  .filter((name) => name.endsWith(".json"))
  .map((name) => readFile(resolve(snapshotDirectory, name), "utf8").then(JSON.parse).catch(() => null)));
const currentSnapshot = { checkedAt, items };
const comparison = compareSnapshots(currentSnapshot, history.filter(Boolean));

const itemsWithComparison = items.map((item) => {
  const metric = comparison.metrics.get(postKey(item));
  return {
    ...item,
    comparison: metric ? {
      previousCheckedAt: metric.previousCheckedAt,
      isNew: metric.isNew,
      measured: metric.measured,
      elapsedHours: metric.elapsedHours,
      previousRank: metric.previousRank,
      rankChange: metric.rankChange,
      viewsDelta: metric.viewsDelta,
      viewsPerHour: metric.viewsPerHour,
      commentsDelta: metric.commentsDelta,
      reactionsDelta: metric.reactionsDelta,
      engagementDelta: metric.engagementDelta
    } : null
  };
});

const daily = {
  date,
  checkedAt,
  channelCheckedAt: checkedAt,
  research: {},
  channels: {
    search: searchEntries,
    social: [...youtubeEntries, ...xEntries]
  },
  collectionStatus: {
    community: collectionStatus.community.status,
    search: collectionStatus.search.status,
    youtube: collectionStatus.youtube.status,
    x: collectionStatus.x.status
  },
  items: itemsWithComparison.map(compactItem)
};

const output = resolve(root, "data", `${date}.json`);
const snapshotName = snapshotFileName(checkedAt, rules.snapshots?.internalTimes);
const snapshotPath = resolve(snapshotDirectory, snapshotName);
const snapshotPayload = compactSnapshot({
  date,
  checkedAt,
  snapshotOnly,
  previousSnapshotCheckedAt: comparison.previous?.checkedAt ?? null,
  disabledSources: channelConfig.disabledSources ?? [],
  collectionStatus,
  channels: {
    search: {
      status: collectionStatus.search.status,
      entries: searchEntries
    },
    social: {
      youtube: {
        status: collectionStatus.youtube.status,
        entries: youtubeEntries,
        reason: collectionStatus.youtube.reason ?? null
      },
      x: {
        status: collectionStatus.x.status,
        entries: xEntries,
        reason: collectionStatus.x.reason ?? null
      }
    }
  },
  items: itemsWithComparison
});

await mkdir(snapshotDirectory, { recursive: true });
await writeFile(snapshotPath, `${JSON.stringify(snapshotPayload)}\n`, "utf8");
if (!snapshotOnly) {
  await writeFile(output, `${JSON.stringify(daily, null, 2)}\n`, "utf8");
}

const measuredCount = [...comparison.metrics.values()].filter((metric) => metric.measured).length;
const newCount = [...comparison.metrics.values()].filter((metric) => metric.isNew).length;
const latestState = {
  schemaVersion: 1,
  date,
  checkedAt,
  snapshot: `snapshots/${date}/${snapshotName}`,
  previousSnapshotCheckedAt: comparison.previous?.checkedAt ?? null,
  counts: { communities: itemsByCommunity.size, posts: items.length, search: searchEntries.length, youtube: youtubeEntries.length, x: xEntries.length, measured: measuredCount, new: newCount },
  status: Object.fromEntries(Object.entries(collectionStatus).filter(([key]) => key !== "disabledSources").map(([key, value]) => [key, value.status]))
};
const stateDirectory = resolve(root, "state");
await mkdir(stateDirectory, { recursive: true });
await writeFile(resolve(stateDirectory, "latest-snapshot.json"), `${JSON.stringify(latestState, null, 2)}\n`, "utf8");

console.log([
  snapshotOnly ? "내부 스냅샷 전용 실행" : output,
  `스냅샷 ${snapshotPath}`,
  `커뮤니티 ${itemsByCommunity.size} · 글 ${items.length} · 검색 ${searchEntries.length} · YouTube ${youtubeEntries.length} · X ${xEntries.length}`,
  `실측 ${measuredCount} · 신규 ${newCount} · 직전 ${comparison.previous?.checkedAt ?? "없음"}`
].join("\n"));
