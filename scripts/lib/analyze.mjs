/**
 * Pure helpers behind scripts/analyze-logs.mjs.
 *
 * Input is the NDJSON produced by `wrangler tail --format json`, but raw
 * `{"evt":"dl",...}` lines are accepted too so logs can be re-analysed from
 * other sources (e.g. an exported Workers Logs file).
 */

const DL_EVENT = 'dl';

/** @param {unknown} value */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Worker log timestamps are milliseconds; tolerate seconds just in case.
    return value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** @param {unknown} value */
function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** @param {unknown} value */
function str(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {number} fallbackTs
 */
function normalizeEvent(raw, fallbackTs) {
  const asset = str(raw.asset);
  if (!asset) return null;

  return {
    t: toMillis(raw.ts ?? raw.time ?? raw.__ts) || fallbackTs,
    colo: str(raw.colo, 'unknown'),
    country: str(raw.country, 'unknown'),
    asn: typeof raw.asn === 'number' ? raw.asn : null,
    repo: str(raw.repo),
    tag: str(raw.tag),
    asset,
    size: num(raw.size),
    status: num(raw.status, 200),
    range: raw.range === true,
    upstreamMs: num(raw.upstreamMs),
    handlerMs: num(raw.handlerMs),
  };
}

/**
 * @param {string} text
 * @returns {Array<{
 *   t: number, colo: string, country: string, asn: number | null,
 *   repo: string, tag: string, asset: string, size: number, status: number,
 *   range: boolean, upstreamMs: number, handlerMs: number
 * }>}
 */
export function parseTailLines(text) {
  const events = [];
  const clean = text.replace(/^\uFEFF/, '');

  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;

    // Raw event line.
    if (record.evt === DL_EVENT) {
      const event = normalizeEvent(record, toMillis(record.__ts));
      if (event) events.push(event);
      continue;
    }

    // `wrangler tail --format json` record.
    const recordTs = toMillis(record.eventTimestamp);
    if (!Array.isArray(record.logs)) continue;

    for (const log of record.logs) {
      if (!log || typeof log !== 'object') continue;
      const messages = Array.isArray(log.message) ? log.message : [log.message];
      const logTs = toMillis(log.timestamp) || recordTs;

      for (const message of messages) {
        if (typeof message !== 'string') continue;
        let inner;
        try {
          inner = JSON.parse(message);
        } catch {
          continue;
        }
        if (!inner || inner.evt !== DL_EVENT) continue;
        const event = normalizeEvent(inner, logTs);
        if (event) events.push(event);
      }
    }
  }

  return events.sort((a, b) => a.t - b.t);
}

/**
 * Replays a per-(colo, asset) TTL cache over the events.
 * Only full 200 responses are considered; Range requests and errors always
 * miss (they would bypass the cache in a real implementation).
 *
 * The implementation lives in shared/stats.mjs so the admin dashboard and
 * this offline tool share exactly the same semantics.
 */
import { quantile, simulateTtl } from '../../shared/stats.mjs';
export { quantile, simulateTtl };

/**
 * @param {ReturnType<typeof parseTailLines>} events
 * @param {number[]} ttlsMs
 */
export function summarize(events, ttlsMs) {
  const successful = events.filter((event) => event.status === 200 && !event.range);

  const ttfb = successful.map((event) => event.upstreamMs).filter((value) => value > 0);
  const handler = successful.map((event) => event.handlerMs).filter((value) => value > 0);

  /** @type {Map<string, { requests: number, bytes: number, colos: Set<string> }>} */
  const assets = new Map();
  /** @type {Map<string, number>} */
  const colos = new Map();

  for (const event of successful) {
    let entry = assets.get(event.asset);
    if (!entry) {
      entry = { requests: 0, bytes: 0, colos: new Set() };
      assets.set(event.asset, entry);
    }
    entry.requests += 1;
    entry.bytes += event.size;
    entry.colos.add(event.colo);
    colos.set(event.colo, (colos.get(event.colo) ?? 0) + 1);
  }

  return {
    totalEvents: events.length,
    successful: successful.length,
    bytes: successful.reduce((sum, event) => sum + event.size, 0),
    ttfb: {
      p50: quantile(ttfb, 0.5),
      p95: quantile(ttfb, 0.95),
    },
    handler: {
      p50: quantile(handler, 0.5),
      p95: quantile(handler, 0.95),
    },
    assets: [...assets.entries()]
      .map(([asset, entry]) => ({
        asset,
        requests: entry.requests,
        bytes: entry.bytes,
        colos: [...entry.colos].sort(),
      }))
      .sort((a, b) => b.requests - a.requests),
    colos: [...colos.entries()]
      .map(([colo, requests]) => ({ colo, requests }))
      .sort((a, b) => b.requests - a.requests),
    ttls: ttlsMs.map((ttlMs) => simulateTtl(events, ttlMs)),
    firstEventAt: events.length > 0 ? events[0].t : 0,
    lastEventAt: events.length > 0 ? events[events.length - 1].t : 0,
  };
}
