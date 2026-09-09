// Pure, unit-testable logic for spotting a real, meaningful drop in a
// tracked competitor's Google rating — no DB, no network. Given rows from
// competitor_rating_history (any order, any set of competitors/tenants
// mixed together is fine — this groups by place_id itself), returns one
// alert per competitor whose most recent snapshot is a real drop from its
// previous one.
//
// Honesty note (this matters — see the discussion this feature came out
// of): Places only ever returns an aggregate rating + review count, never
// individual review text. A drop here means "the average moved down,"
// not "a specific bad review was spotted" — callers must not phrase this
// as "a new 1-2 star review."

const RATING_DROP_THRESHOLD = 0.2; // stars — smaller moves are noise on a 5-point scale
const MIN_REVIEW_COUNT_FOR_SIGNAL = 5; // a competitor with only a couple of reviews swings wildly on one new review either way — not useful "should I act" signal

function detectRatingDrops(historyRows) {
  const byPlace = new Map();
  for (const row of historyRows || []) {
    if (!row || !row.place_id) continue;
    if (!byPlace.has(row.place_id)) byPlace.set(row.place_id, []);
    byPlace.get(row.place_id).push(row);
  }

  const alerts = [];
  for (const [placeId, rows] of byPlace.entries()) {
    const sorted = [...rows].sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at));
    if (sorted.length < 2) continue; // need a prior snapshot to compare against
    const latest = sorted[sorted.length - 1];
    const previous = sorted[sorted.length - 2];
    if (latest.rating == null || previous.rating == null) continue;
    if ((latest.review_count ?? 0) < MIN_REVIEW_COUNT_FOR_SIGNAL) continue;

    const drop = Number(previous.rating) - Number(latest.rating);
    if (drop >= RATING_DROP_THRESHOLD) {
      alerts.push({
        placeId,
        competitorName: latest.competitor_name,
        previousRating: Number(previous.rating),
        currentRating: Number(latest.rating),
        drop: Math.round(drop * 10) / 10,
        previousCheckedAt: previous.checked_at,
        currentCheckedAt: latest.checked_at,
        reviewCount: latest.review_count ?? null
      });
    }
  }
  return alerts.sort((a, b) => b.drop - a.drop);
}

module.exports = { detectRatingDrops, RATING_DROP_THRESHOLD, MIN_REVIEW_COUNT_FOR_SIGNAL };
