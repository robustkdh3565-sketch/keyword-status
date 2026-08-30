export function compactItem(item) {
  return {
    community: item.community,
    topic: item.topic,
    normalizedTitle: item.normalizedTitle ?? null,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    publishedAtSource: item.publishedAtSource,
    views: item.views ?? null,
    comments: item.comments ?? null,
    reactions: item.reactions ?? null,
    rank: item.rank ?? null,
    candidateCount: item.candidateCount ?? null,
    source: item.source ?? null,
    sourceRanks: item.sourceRanks ?? [],
    comparison: item.comparison ?? null,
    needsVerification: item.needsVerification ?? true
  };
}

export function compactSnapshot(snapshot) {
  return {
    schemaVersion: 2,
    date: snapshot.date,
    checkedAt: snapshot.checkedAt,
    previousSnapshotCheckedAt: snapshot.previousSnapshotCheckedAt ?? null,
    collectionStatus: snapshot.collectionStatus,
    channels: snapshot.channels,
    items: (snapshot.items ?? []).map(compactItem)
  };
}

export function snapshotFileName(checkedAt, internalTimes = []) {
  const checkedTime = checkedAt.slice(11, 19);
  const scheduledHour = internalTimes.find((time) => time.slice(0, 2) === checkedTime.slice(0, 2));
  return `${scheduledHour ? `${scheduledHour.slice(0, 2)}0000` : checkedTime.replaceAll(":", "")}.json`;
}
