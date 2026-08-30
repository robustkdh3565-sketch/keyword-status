export function todayBestCommunityIds(todayBestMap) {
  return new Set(Object.values(todayBestMap));
}

export function selectMoamoaCommunities({ snapshotOnly, rules, collectedCommunityIds = new Set(), todayBestIds = new Set() }) {
  const moamoaIds = rules.communities
    .filter((community) => community.sources.includes("moamoa"))
    .map((community) => community.id);
  if (!snapshotOnly) return moamoaIds;
  return moamoaIds.filter((id) => !todayBestIds.has(id) || !collectedCommunityIds.has(id));
}

export function shouldCollectSocialSource({ snapshotOnly, source }) {
  if (!snapshotOnly) return true;
  return source === "googleTrends";
}
