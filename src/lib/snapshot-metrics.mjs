import { normalizeTitle } from "./topic-normalizer.mjs";

export function postKey(item) {
  return `${item.community}\u0000${normalizeTitle(item.title).toLowerCase()}`;
}

const finite = (value) => Number.isFinite(Number(value));

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
    metrics.set(postKey(item), {
      isNew: Boolean(previous) && !before,
      measured: Boolean(before && elapsedHours && viewsDelta >= 0),
      elapsedHours,
      viewsDelta: viewsDelta >= 0 ? viewsDelta : null,
      viewsPerHour: viewsDelta >= 0 && elapsedHours ? viewsDelta / elapsedHours : null,
      engagementDelta: (commentsDelta >= 0 ? commentsDelta : 0) + (reactionsDelta >= 0 ? reactionsDelta : 0),
      rankChange: before && finite(before.rank) && finite(item.rank) ? Number(before.rank) - Number(item.rank) : null,
      previousRank: before?.rank ?? null
    });
  }
  return { previous, metrics };
}
