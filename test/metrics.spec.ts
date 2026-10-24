import { env, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordMetric } from '../src/download';
import type { MetricEvent, MetricsDO } from '../src/metrics-do';
import { adminCookie, ORIGIN, OTHER_REPO, performDownload, REPO, useUpstreamMock } from './helpers';

useUpstreamMock();

beforeEach(async () => {
  await reset();
});

interface SummaryPayload {
  range: string;
  summary: {
    requests: number;
    cacheable: number;
    bytes: number;
    assets: Array<{
      repo: string;
      asset: string;
      requests: number;
      ttls: Array<{ hitRate: number }>;
    }>;
    colos: Array<{ colo: string; requests: number }>;
    ttls: Array<{ hitRate: number; originShare: number }>;
  };
}

async function fetchSummaryOnce(range: string): Promise<SummaryPayload> {
  const response = await SELF.fetch(`${ORIGIN}/admin/data.json?range=${range}`, {
    headers: { cookie: await adminCookie() },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SummaryPayload;
}

/**
 * Metrics are recorded with `ctx.waitUntil()`, so the write can land slightly
 * after the download response is returned. Poll until the expected state is
 * visible instead of assuming the write already happened.
 */
async function fetchSummary(
  range = '24h',
  ready: (payload: SummaryPayload) => boolean = () => true,
): Promise<SummaryPayload> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const payload = await fetchSummaryOnce(range);
    if (ready(payload)) return payload;
    if (Date.now() > deadline) throw new Error('metrics were not recorded in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function metric(ts: number, overrides: Partial<MetricEvent> = {}): MetricEvent {
  return {
    ts,
    colo: 'SJC',
    country: 'US',
    asn: 4134,
    repo: REPO,
    tag: 'v1.0.0',
    asset: 'app-1.0.0.zip',
    size: 1000,
    status: 200,
    range: false,
    redirects: 1,
    upstreamMs: 10,
    handlerMs: 20,
    ...overrides,
  };
}

describe('download metrics', () => {
  it('aggregates repeated downloads into a simulated hit rate', async () => {
    await performDownload();
    await performDownload();

    const payload = await fetchSummary('24h', (data) => data.summary.requests === 2);

    expect(payload.summary.requests).toBe(2);
    expect(payload.summary.cacheable).toBe(2);
    expect(payload.summary.assets[0]?.repo).toBe(REPO);
    expect(payload.summary.assets[0]?.asset).toBe('app-1.0.0.zip');
    expect(payload.summary.assets[0]?.requests).toBe(2);
    expect(payload.summary.ttls[0]?.hitRate).toBeCloseTo(0.5);
    expect(payload.summary.ttls[0]?.originShare).toBeCloseTo(0.5);
  });

  it('counts Range requests but keeps them out of the cache simulation', async () => {
    await performDownload();
    await performDownload();
    await performDownload('app-1.0.0.zip', { range: 'bytes=0-3' });

    const payload = await fetchSummary('24h', (data) => data.summary.requests === 3);

    expect(payload.summary.requests).toBe(3);
    expect(payload.summary.cacheable).toBe(2);
    expect(payload.summary.ttls[0]?.hitRate).toBeCloseTo(0.5);
  });

  it('keeps the same asset name in different repos separate', async () => {
    await performDownload();
    await performDownload('app-1.0.0.zip', { repo: OTHER_REPO });

    const payload = await fetchSummary('24h', (data) => data.summary.requests === 2);

    expect(payload.summary.assets).toHaveLength(2);
    expect(payload.summary.assets.map((asset) => asset.repo).sort()).toEqual(
      [REPO, OTHER_REPO].sort(),
    );
    // Two independent cache keys: nothing can hit.
    expect(payload.summary.ttls[0]?.hitRate).toBe(0);
  });

  it('keeps the newest rows when the window is truncated', async () => {
    const stub = env.METRICS.get(env.METRICS.idFromName('global')) as DurableObjectStub<MetricsDO>;

    await runInDurableObject(stub, async (instance) => {
      const base = Date.now() - 5000;
      for (let i = 0; i < 5; i += 1) {
        await instance.record(metric(base + i, { asset: `asset-${i}.zip` }));
      }

      const summary = await instance.summary(1, 2);

      expect(summary.requests).toBe(2);
      expect(summary.firstTs).toBe(base + 3);
      expect(summary.lastTs).toBe(base + 4);
      expect(summary.truncated).toBe(true);
    });
  });

  it('invalidates the summary cache when a new event is recorded', async () => {
    const stub = env.METRICS.get(env.METRICS.idFromName('global')) as DurableObjectStub<MetricsDO>;

    await runInDurableObject(stub, async (instance) => {
      const now = Date.now();
      await instance.record(metric(now));
      expect((await instance.summary(1)).requests).toBe(1);

      await instance.record(metric(now + 1));
      expect((await instance.summary(1)).requests).toBe(2);
    });
  });

  it('clamps the dashboard window to 1..30 days', async () => {
    const stub = env.METRICS.get(env.METRICS.idFromName('global')) as DurableObjectStub<MetricsDO>;

    await runInDurableObject(stub, async (instance) => {
      expect((await instance.summary(0)).days).toBe(1);
      expect((await instance.summary(365)).days).toBe(30);
      expect((await instance.summary(Number.NaN)).days).toBe(7);
    });
  });

  it('prunes expired rows through the daily alarm', async () => {
    const stub = env.METRICS.get(env.METRICS.idFromName('global')) as DurableObjectStub<MetricsDO>;

    await runInDurableObject(stub, async (instance, state) => {
      await instance.record(metric(Date.now()));
      await instance.record(metric(Date.now() - 31 * 86_400_000));

      await instance.alarm();

      const row = state.storage.sql.exec('SELECT COUNT(*) AS n FROM events').one() as unknown as {
        n: number;
      };
      expect(row.n).toBe(1);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });

  it('tolerates a missing or failing metrics binding', async () => {
    const event = metric(Date.now());

    await expect(recordMetric({} as Env, event)).resolves.toBeUndefined();

    const failing = {
      METRICS: {
        idFromName: () => 'global',
        get() {
          throw new Error('metrics unavailable');
        },
      },
    } as unknown as Env;
    await expect(recordMetric(failing, event)).resolves.toBeUndefined();
  });

  it('renders the data on the admin dashboard', async () => {
    await performDownload();
    await fetchSummary('24h', (data) => data.summary.requests === 1);

    const response = await SELF.fetch(`${ORIGIN}/admin`, {
      headers: { cookie: await adminCookie() },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('app-1.0.0.zip');
    expect(html).toContain('0.0%');
  });

  it('escapes spreadsheet formulas in CSV exports', async () => {
    await performDownload('+1+1.zip');
    await fetchSummary('24h', (data) => data.summary.requests === 1);

    const response = await SELF.fetch(`${ORIGIN}/admin/export.csv?range=24h`, {
      headers: { cookie: await adminCookie() },
    });
    const csv = await response.text();

    expect(csv).toContain('repo,asset,tag,requests');
    expect(csv).toContain("'+1+1.zip");
  });

  it('streams the download body when metrics are enabled', async () => {
    // The binding is always present in tests, so this asserts the happy path
    // still streams the body rather than being blocked by recording.
    const response = await performDownload();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('payload');
  });
});
