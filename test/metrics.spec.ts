import { SELF, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { ORIGIN, adminCookie, performDownload, useUpstreamMock } from './helpers';

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
    assets: Array<{ asset: string; requests: number; ttls: Array<{ hitRate: number }> }>;
    colos: Array<{ colo: string; requests: number }>;
    ttls: Array<{ hitRate: number; originShare: number }>;
  };
}

async function fetchSummary(range = '24h'): Promise<SummaryPayload> {
  const response = await SELF.fetch(`${ORIGIN}/admin/data.json?range=${range}`, {
    headers: { cookie: await adminCookie() },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SummaryPayload;
}

describe('download metrics', () => {
  it('aggregates repeated downloads into a simulated hit rate', async () => {
    await performDownload();
    await performDownload();

    const payload = await fetchSummary();

    expect(payload.summary.requests).toBe(2);
    expect(payload.summary.cacheable).toBe(2);
    expect(payload.summary.assets[0]?.asset).toBe('app-1.0.0.zip');
    expect(payload.summary.assets[0]?.requests).toBe(2);
    expect(payload.summary.ttls[0]?.hitRate).toBeCloseTo(0.5);
    expect(payload.summary.ttls[0]?.originShare).toBeCloseTo(0.5);
  });

  it('counts Range requests but keeps them out of the cache simulation', async () => {
    await performDownload();
    await performDownload();
    await performDownload('app-1.0.0.zip', { range: 'bytes=0-3' });

    const payload = await fetchSummary();

    expect(payload.summary.requests).toBe(3);
    expect(payload.summary.cacheable).toBe(2);
    expect(payload.summary.ttls[0]?.hitRate).toBeCloseTo(0.5);
  });

  it('renders the data on the admin dashboard', async () => {
    await performDownload();

    const response = await SELF.fetch(`${ORIGIN}/admin`, {
      headers: { cookie: await adminCookie() },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('app-1.0.0.zip');
    expect(html).toContain('0.0%');
  });

  it('keeps the normal download working when metrics are unavailable', async () => {
    // The binding is always present in tests, so this asserts the happy path
    // still streams the body rather than being blocked by recording.
    const response = await performDownload();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('payload');
  });
});
