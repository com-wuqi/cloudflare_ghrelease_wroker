/**
 * Shared cache-simulation maths, used by both the admin dashboard
 * (Worker -> Durable Object) and scripts/analyze-logs.mjs.
 *
 * Semantics: a per-(colo, repo, asset) TTL cache. Only full 200 responses are
 * cacheable; a hit does NOT refresh the window, only a miss does.
 */

/**
 * @param {Array<{ t: number, colo: string, repo: string, asset: string, size: number, status: number, range: boolean }>} events
 * @param {number} ttlMs
 */
export function simulateTtl(events, ttlMs) {
  /** @type {Map<string, Array<{ t: number, size: number }>>} */
  const groups = new Map();

  for (const event of events) {
    if (event?.status !== 200 || event.range) continue;
    const key = `${event.colo}\u0000${event.repo}\u0000${event.asset}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push({ t: event.t, size: event.size });
  }

  let hits = 0;
  let misses = 0;
  let bytesServed = 0;
  let bytesSaved = 0;

  for (const list of groups.values()) {
    list.sort((a, b) => a.t - b.t);
    let lastMissAt = Number.NEGATIVE_INFINITY;

    for (const event of list) {
      bytesServed += event.size;
      if (lastMissAt !== Number.NEGATIVE_INFINITY && event.t - lastMissAt <= ttlMs) {
        hits += 1;
        bytesSaved += event.size;
      } else {
        misses += 1;
        lastMissAt = event.t;
      }
    }
  }

  const total = hits + misses;
  return {
    ttlMs,
    hits,
    misses,
    total,
    hitRate: total === 0 ? 0 : hits / total,
    originShare: total === 0 ? 0 : misses / total,
    bytesServed,
    bytesSaved,
  };
}

/**
 * Linear-interpolated quantile.
 * @param {number[]} values
 * @param {number} q
 */
export function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (position - low);
}
