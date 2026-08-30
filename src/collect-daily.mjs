import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rules = JSON.parse(await readFile(resolve(root, "config/rules.json"), "utf8"));
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
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
}).format(now).replace(" ", "T") + "+09:00";

const communityIds = new Set(rules.communities.map((community) => community.id));
const todayBestMap = {
  "82C": "82cook", ARC: "arca", BOB: "bobae", CLI: "clien", DCI: "dcinside",
  DDA: "ddanzi", DOG: "dogdrip", ETO: "etoland", FMK: "fmkorea", GAS: "gasengi",
  INS: "instiz", INV: "inven", MLB: "mlbpark", NAT: "natepann", PPO: "ppomppu",
  QOO: "theqoo", RUL: "ruliweb", YGO: "ygosu"
};

const topicFromTitle = (title) => String(title)
  .replace(/\.(jpg|jpeg|png|gif|mp4)\b/gi, "")
  .replace(/^\s*(실시간|충격|현재|속보|혐주의)[)\]\s:.-]*/gi, "")
  .replace(/\s*[ㅋㅎㄷ]{2,}\s*$/g, "")
  .trim();

const itemsByCommunity = new Map();
const add = (item) => {
  if (!communityIds.has(item.community) || !item.url) return;
  const list = itemsByCommunity.get(item.community) ?? [];
  if (!list.some((existing) => existing.url === item.url)) list.push(item);
  itemsByCommunity.set(item.community, list);
};

const groupedUrl = `https://todaybeststory.com/api/v2/communities/posts/grouped-best?startDate=${date}&endDate=${date}&topN=10`;
const grouped = await fetch(groupedUrl).then((response) => {
  if (!response.ok) throw new Error(`오늘의베스트 ${response.status}`);
  return response.json();
});
for (const community of grouped.communities ?? []) {
  const id = todayBestMap[community.communityId];
  if (!id) continue;
  (community.posts ?? []).slice(0, 10).forEach((post, index) => add({
    community: id,
    topic: topicFromTitle(post.postTitle),
    title: post.postTitle,
    url: post.postUrl,
    publishedAt: post.postDatetime ?? checkedAt,
    views: post.readCount,
    comments: post.commentCount,
    reactions: post.upvoteCount,
    rank: index + 1,
    candidateCount: Math.min(10, community.posts.length),
    source: "todayBest",
    needsVerification: true
  }));
}

const moamoaIds = rules.communities.filter((community) => community.sources.includes("moamoa")).map((community) => community.id);
for (const id of moamoaIds) {
  try {
    const posts = await fetch(`https://moamoa.kr/api?scope=24&sort=popular&sites=${id}`).then((response) => response.json());
    posts.slice(0, 10).forEach((post, index) => add({
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
      views: post.views,
      comments: post.comments,
      reactions: Math.max(0, Number(post.point ?? 0) - Number(post.views ?? 0)),
      rank: index + 1,
      candidateCount: Math.min(10, posts.length),
      source: "moamoa",
      needsVerification: true
    }));
  } catch (error) {
    console.warn(`모아모아 ${id}: ${error.message}`);
  }
}

const items = [...itemsByCommunity.values()].flatMap((posts) => posts
  .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
  .slice(0, 10)
  .map((post, index, selected) => ({ ...post, rank: index + 1, candidateCount: selected.length })));

const rss = await fetch("https://trends.google.com/trending/rss?geo=KR").then((response) => response.text());
const search = [...rss.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<ht:approx_traffic>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/ht:approx_traffic>[\s\S]*?<\/item>/g)]
  .slice(0, 10)
  .map((match, index) => ({
    rank: index + 1,
    keyword: match[1],
    source: "Google Trends 한국",
    metric: `급상승 검색 ${match[2]}`,
    url: "https://trends.google.com/trending?geo=KR"
  }));

const social = [
  [1, "$CHUMP", "X 한국", "실시간 1위", "https://x.com/search?q=%24CHUMP"],
  [2, "라이브뷰잉", "X 한국", "실시간 2위", "https://x.com/search?q=%EB%9D%BC%EC%9D%B4%EB%B8%8C%EB%B7%B0%EC%9E%89"],
  [3, "#ENHYPEN23rdWin", "X 한국", "실시간 3위", "https://x.com/search?q=%23ENHYPEN23rdWin"],
  [4, "#HoYoLAND2026", "X 한국", "실시간 4위", "https://x.com/search?q=%23HoYoLAND2026"],
  [5, "#호요랜드2026", "X 한국", "실시간 5위", "https://x.com/search?q=%23%ED%98%B8%EC%9A%94%EB%9E%9C%EB%93%9C2026"],
  [1, "HEAVEN JENNIE", "YouTube 한국", "인기 1위 · 조회 349,000 · 시간당 8,000", "https://youtube.com/watch?v=LNk-BX38FzQ"],
  [2, "재혼 황후 티저 예고편", "YouTube 한국", "인기 2위 · 조회 1,500,000 · 시간당 16,000", "https://youtube.com/watch?v=CDhtpYWNEuk"],
  [3, "T1 vs BFX LCK 플레이오프", "YouTube 한국", "인기 3위 · 조회 2,000,000 · 시간당 185,000", "https://youtube.com/watch?v=LSCnrGz5-HU"],
  [4, "송하예 행복한 나를 2026", "YouTube 한국", "인기 4위 · 조회 302,000 · 시간당 4,800", "https://youtube.com/watch?v=Gk8F8waA0tM"],
  [5, "가능한 사랑 공식 예고편", "YouTube 한국", "인기 5위 · 조회 898,000 · 시간당 12,000", "https://youtube.com/watch?v=W1kDOqqWNiw"]
].map(([rank, keyword, source, metric, url]) => ({ rank, keyword, source, metric, url }));

const daily = { date, checkedAt, channelCheckedAt: checkedAt, research: {}, channels: { search, social }, items };
const output = resolve(root, "data", `${date}.json`);
await writeFile(output, `${JSON.stringify(daily, null, 2)}\n`, "utf8");
console.log(`${output}\n커뮤니티 ${itemsByCommunity.size}개 · 게시물 ${items.length}건 · 검색 ${search.length}건 · SNS ${social.length}건`);
