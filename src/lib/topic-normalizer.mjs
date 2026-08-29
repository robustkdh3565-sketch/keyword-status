const rankPrefix = /^\s*\d+\s*/;

export function normalizeTitle(title, options = {}) {
  const stopwords = new Set(options.stopwords ?? []);
  const cleaned = String(title ?? "")
    .normalize("NFKC")
    .replace(rankPrefix, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\.(jpg|jpeg|png|gif|mp4|webp)\b/gi, " ")
    .replace(/[\[\](){}<>“”‘’'"!?~…:;|/\\,+*=#@%^&₩$·•🔥💥]/g, " ")
    .replace(/[\u1100-\u11ff\u3130-\u318f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .split(" ")
    .filter((token) => token.length > 1 && !stopwords.has(token.toLowerCase()))
    .join(" ")
    .trim() || cleaned;
}

export function tokenSet(value, options = {}) {
  return new Set(normalizeTitle(value, options).toLowerCase().split(/\s+/).filter(Boolean));
}

export function jaccardSimilarity(left, right, options = {}) {
  const a = tokenSet(left, options);
  const b = tokenSet(right, options);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const jaccard = intersection / new Set([...a, ...b]).size;
  const overlap = intersection / Math.min(a.size, b.size);
  return Math.max(jaccard, overlap);
}

export function clusterItems(items, options = {}) {
  const threshold = Number(options.similarityThreshold ?? 0.56);
  const clusters = [];
  for (const original of items) {
    const item = { ...original };
    const candidate = normalizeTitle(item.topic || item.title, options);
    let match = clusters.find((cluster) =>
      cluster.canonical === candidate || jaccardSimilarity(cluster.canonical, candidate, options) >= threshold
    );
    if (!match) {
      match = { canonical: candidate, items: [] };
      clusters.push(match);
    }
    item.topic = match.canonical;
    match.items.push(item);
  }
  return clusters.flatMap((cluster) => cluster.items);
}
