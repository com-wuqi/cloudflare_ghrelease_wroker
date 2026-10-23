import { DurableObject } from 'cloudflare:workers';

import { quantile, simulateTtl, type TtlEvent, type TtlSimulation } from '../shared/stats.mjs';

const TTL_WINDOWS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000];
const MAX_ROWS = 50_000;
const DEFAULT_RETENTION_DAYS = 30;
const PRUNE_EVERY_WRITES = 200;

export interface MetricEvent {
  ts: number;
  colo: string;
  country: string;
  asn: number | null;
  repo: string;
  tag: string;
  asset: string;
  size: number;
  status: number;
  range: boolean;
  redirects: number;
  upstreamMs: number;
  handlerMs: number;
}

export interface AssetStats {
  asset: string;
  tag: string;
  requests: number;
  bytes: number;
  colos: string[];
  ttls: TtlSimulation[];
}

export interface ColoStats {
  colo: string;
  country: string;
  requests: number;
  bytes: number;
}

export interface MetricsSummary {
  days: number;
  requests: number;
  cacheable: number;
  bytes: number;
  assets: AssetStats[];
  colos: ColoStats[];
  ttfb: { p50: number; p95: number };
  handler: { p50: number; p95: number };
  ttls: TtlSimulation[];
  firstTs: number;
  lastTs: number;
  truncated: boolean;
}

export interface MetricsStub {
  record(event: MetricEvent): Promise<void>;
  summary(days: number): Promise<MetricsSummary>;
}

interface EventRow {
  ts: number;
  colo: string;
  country: string;
  asset: string;
  tag: string;
  size: number;
  status: number;
  is_range: number;
  upstream_ms: number;
  handler_ms: number;
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 7;
  return Math.min(Math.max(Math.trunc(days), 1), 30);
}

function toTtlEvent(row: EventRow): TtlEvent {
  return {
    t: Number(row.ts),
    colo: String(row.colo),
    asset: String(row.asset),
    size: Number(row.size),
    status: Number(row.status),
    range: Number(row.is_range) === 1,
  };
}

function isCacheable(row: EventRow): boolean {
  return Number(row.status) === 200 && Number(row.is_range) === 0;
}

function isSuccessful(row: EventRow): boolean {
  const status = Number(row.status);
  return status === 200 || status === 206;
}

/**
 * One global SQLite-backed Durable Object holds the download events.
 *
 * Writes are tiny (one row per authorized download) and the dashboard only
 * aggregates a bounded window (<= 30 days, <= 50k rows), so a single instance
 * is plenty and keeps the deployment free of external services.
 */
export class MetricsDO extends DurableObject<Env> {
  private writes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        ts INTEGER NOT NULL,
        colo TEXT NOT NULL,
        country TEXT NOT NULL,
        asn INTEGER,
        repo TEXT NOT NULL,
        tag TEXT NOT NULL,
        asset TEXT NOT NULL,
        size INTEGER NOT NULL,
        status INTEGER NOT NULL,
        is_range INTEGER NOT NULL,
        redirects INTEGER NOT NULL,
        upstream_ms INTEGER NOT NULL,
        handler_ms INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)');
  }

  async record(event: MetricEvent): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO events
        (ts, colo, country, asn, repo, tag, asset, size, status, is_range, redirects, upstream_ms, handler_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.ts,
      event.colo,
      event.country,
      event.asn,
      event.repo,
      event.tag,
      event.asset,
      event.size,
      event.status,
      event.range ? 1 : 0,
      event.redirects,
      event.upstreamMs,
      event.handlerMs,
    );

    this.writes += 1;
    if (this.writes % PRUNE_EVERY_WRITES === 0) this.prune();
  }

  async summary(days: number): Promise<MetricsSummary> {
    const windowDays = clampDays(days);
    const cutoff = Date.now() - windowDays * 86_400_000;

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT ts, colo, country, asset, tag, size, status, is_range, upstream_ms, handler_ms
         FROM events
         WHERE ts >= ?
         ORDER BY ts
         LIMIT ?`,
        cutoff,
        MAX_ROWS,
      )
      .toArray() as unknown as EventRow[];

    const successful = rows.filter(isSuccessful);
    const cacheable = successful.filter(isCacheable);

    const ttfbValues = successful
      .map((row) => Number(row.upstream_ms))
      .filter((value) => value > 0);
    const handlerValues = successful
      .map((row) => Number(row.handler_ms))
      .filter((value) => value > 0);

    const events = rows.map(toTtlEvent);

    /** @type {Map<string, AssetStats & { events: TtlEvent[] }>} */
    const assets = new Map<string, AssetStats & { events: TtlEvent[] }>();
    /** @type {Map<string, ColoStats>} */
    const colos = new Map<string, ColoStats>();

    for (const row of successful) {
      const assetName = String(row.asset);
      let asset = assets.get(assetName);
      if (!asset) {
        asset = {
          asset: assetName,
          tag: String(row.tag),
          requests: 0,
          bytes: 0,
          colos: [],
          ttls: [],
          events: [],
        };
        assets.set(assetName, asset);
      }
      asset.requests += 1;
      asset.bytes += Number(row.size);
      if (!asset.colos.includes(String(row.colo))) asset.colos.push(String(row.colo));
      if (isCacheable(row)) asset.events.push(toTtlEvent(row));

      const coloName = String(row.colo);
      let colo = colos.get(coloName);
      if (!colo) {
        colo = { colo: coloName, country: String(row.country), requests: 0, bytes: 0 };
        colos.set(coloName, colo);
      }
      colo.requests += 1;
      colo.bytes += Number(row.size);
    }

    const assetList: AssetStats[] = [...assets.values()]
      .map((asset) => ({
        asset: asset.asset,
        tag: asset.tag,
        requests: asset.requests,
        bytes: asset.bytes,
        colos: asset.colos.sort(),
        ttls: TTL_WINDOWS.map((ttl) => simulateTtl(asset.events, ttl)),
      }))
      .sort((a, b) => b.requests - a.requests || a.asset.localeCompare(b.asset));

    const coloList: ColoStats[] = [...colos.values()].sort(
      (a, b) => b.requests - a.requests || a.colo.localeCompare(b.colo),
    );

    const timestamps = successful.map((row) => Number(row.ts));

    return {
      days: windowDays,
      requests: successful.length,
      cacheable: cacheable.length,
      bytes: successful.reduce((sum, row) => sum + Number(row.size), 0),
      assets: assetList,
      colos: coloList,
      ttfb: { p50: quantile(ttfbValues, 0.5), p95: quantile(ttfbValues, 0.95) },
      handler: { p50: quantile(handlerValues, 0.5), p95: quantile(handlerValues, 0.95) },
      ttls: TTL_WINDOWS.map((ttl) => simulateTtl(events, ttl)),
      firstTs: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      lastTs: timestamps.length > 0 ? Math.max(...timestamps) : 0,
      truncated: rows.length >= MAX_ROWS,
    };
  }

  private retentionDays(): number {
    const raw = Number.parseInt(this.env.METRICS_RETENTION_DAYS ?? '', 10);
    if (!Number.isFinite(raw)) return DEFAULT_RETENTION_DAYS;
    return Math.min(Math.max(raw, 1), 365);
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionDays() * 86_400_000;
    this.ctx.storage.sql.exec('DELETE FROM events WHERE ts < ?', cutoff);
  }
}
