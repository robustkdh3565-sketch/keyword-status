import { normalizeTitle } from "./topic-normalizer.mjs";

export function postKey(item) {
  return `${item.community}\u0000${postIdentity(item)}`;
}

export function postIdentity(item) {
  try {
    const url = new URL(item.url);
    const preferredKeys = ["document_srl", "wr_id", "number", "no", "No", "num"];
    for (const key of preferredKeys) {
      const value = url.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return `id:${value}`;
    }
    const id = url.searchParams.get("id");
    if (id && /^\d{6,}$/.test(id)) return `id:${id}`;
    const pathNumbers = url.pathname.match(/\d{6,}/g);
    if (pathNumbers?.length) return `id:${pathNumbers.at(-1)}`;
    const cleaned = `${url.hostname}${url.pathname}`.replace(/\/$/, "").toLowerCase();
    if (cleaned) return `url:${cleaned}`;
  } catch {
    // URL이 손상된 경우에만 제목을 마지막 식별 수단으로 사용한다.
  }
  return `title:${normalizeTitle(item.title).toLowerCase()}`;
}

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

export function compareSnapshots(current, history = []) {
  const currentAt = new Date(current.checkedAt);
  const previous = [...history]
    .filter((snapshot) => new Date(snapshot.checkedAt) < currentAt)
    .sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))[0];
  const previousByKey = new Map((previous?.items ?? []).map((item) => [postKey(item), item]));
  const elapsedHours = previous ? Math.max(0.01, (currentAt - new Date(previous.checkedAt)) / 3_600_000) : null;
  const metrics = new Map();

  for (const item of current.items ?? []) {
    const before = previousByKey.get(postKey(item));
    const viewsDelta = before && finite(item.views) && finite(before.views) ? Number(item.views) - Number(before.views) : null;
    const commentsDelta = before && finite(item.comments) && finite(before.comments) ? Number(item.comments) - Number(before.comments) : null;
    const reactionsDelta = before && finite(item.reactions) && finite(before.reactions) ? Number(item.reactions) - Number(before.reactions) : null;
    const hasMeasuredEngagement = commentsDelta !== null || reactionsDelta !== null;
    const hasMeasuredViews = viewsDelta !== null && viewsDelta >= 0;
    metrics.set(postKey(item), {
      isNew: Boolean(previous) && !before,
      measured: Boolean(before && elapsedHours && hasMeasuredViews),
      elapsedHours,
      viewsDelta: hasMeasuredViews ? viewsDelta : null,
      viewsPerHour: hasMeasuredViews && elapsedHours ? viewsDelta / elapsedHours : null,
      commentsDelta: commentsDelta >= 0 ? commentsDelta : null,
      reactionsDelta: reactionsDelta >= 0 ? reactionsDelta : null,
      engagementDelta: hasMeasuredEngagement
        ? (commentsDelta >= 0 ? commentsDelta : 0) + (reactionsDelta >= 0 ? reactionsDelta : 0)
        : null,
      rankChange: before && finite(before.rank) && finite(item.rank) ? Number(before.rank) - Number(item.rank) : null,
      previousRank: before?.rank ?? null,
      previousCheckedAt: previous?.checkedAt ?? null
    });
  }
  return { previous, metrics };
}
