import { describe, expect, it } from 'vitest';

import type { DownloadEvent } from '../scripts/lib/analyze.mjs';
import { parseTailLines, quantile, simulateTtl, summarize } from '../scripts/lib/analyze.mjs';

const BASE: Omit<DownloadEvent, 't'> = {
  colo: 'SJC',
  country: 'US',
  asn: 4134,
  repo: 'example/app',
  tag: 'v1.0.0',
  asset: 'app.zip',
  size: 1000,
  status: 200,
  range: false,
  upstreamMs: 400,
  handlerMs: 520,
};

function tailRecord(message: Record<string, unknown>, timestamp = 1_700_000_000_000) {
  return JSON.stringify({
    outcome: 'ok',
    eventTimestamp: timestamp,
    logs: [
      { message: [JSON.stringify({ evt: 'dl', ...message })], level: 'log', timestamp },
    ],
  });
}

function event(overrides: Partial<DownloadEvent> & { t: number }): DownloadEvent {
  return { ...BASE, ...overrides };
}

describe('parseTailLines', () => {
  it('extracts events from a wrangler tail record', () => {
    const events = parseTailLines(tailRecord({ ...BASE, ts: 1_700_000_000_000 }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      colo: 'SJC',
      country: 'US',
      asn: 4134,
      asset: 'app.zip',
      size: 1000,
      status: 200,
      upstreamMs: 400,
    });
  });

  it('accepts raw event lines and a UTF-8 BOM', () => {
    const text = `\uFEFF${JSON.stringify({ ...BASE, evt: 'dl', ts: 1_700_000_000_000 })}`;

    const events = parseTailLines(text);
    expect(events).toHaveLength(1);
    expect(events[0]?.asset).toBe('app.zip');
  });

  it('skips malformed lines and unrelated logs', () => {
    const text = [
      'not json',
      JSON.stringify({ message: 'hello' }),
      JSON.stringify({ eventTimestamp: 1, logs: [{ message: ['{"evt":"other"}'] }] }),
      tailRecord({ ...BASE, ts: 2 }),
      '',
    ].join('\n');

    const events = parseTailLines(text);
    expect(events).toHaveLength(1);
  });

  it('falls back to the tail record timestamp', () => {
    const events = parseTailLines(tailRecord(BASE, 1_700_000_123_000));
    expect(events[0]?.t).toBe(1_700_000_123_000);
  });
});

describe('simulateTtl', () => {
  it('counts repeats inside the window as hits', () => {
    const events = [
      event({ t: 0 }),
      event({ t: 1000 }),
      event({ t: 5000 }),
      event({ t: 5500 }),
    ];

    const result = simulateTtl(events, 2000);

    expect(result.misses).toBe(2); // 0 and 5000
    expect(result.hits).toBe(2); // 1000 and 5500
    expect(result.hitRate).toBeCloseTo(0.5);
    expect(result.originShare).toBeCloseTo(0.5);
    expect(result.bytesSaved).toBe(2000);
  });

  it('keeps different colos separate', () => {
    const events = [
      event({ t: 0, colo: 'SJC' }),
      event({ t: 100, colo: 'HKG' }),
    ];

    const result = simulateTtl(events, 3600_000);
    expect(result.hits).toBe(0);
    expect(result.misses).toBe(2);
  });

  it('keeps different assets separate', () => {
    const events = [
      event({ t: 0, asset: 'a.zip' }),
      event({ t: 100, asset: 'b.zip' }),
    ];

    const result = simulateTtl(events, 3600_000);
    expect(result.hits).toBe(0);
  });

  it('never counts Range requests or errors', () => {
    const events = [
      event({ t: 0 }),
      event({ t: 100, range: true }),
      event({ t: 200, status: 206 }),
      event({ t: 300, status: 502 }),
      event({ t: 400 }),
    ];

    const result = simulateTtl(events, 3600_000);

    expect(result.total).toBe(2);
    expect(result.hits).toBe(1);
    expect(result.misses).toBe(1);
  });

  it('a hit does not refresh the window (only misses do)', () => {
    const events = [
      event({ t: 0 }),
      event({ t: 1500 }),
      event({ t: 3000 }),
      event({ t: 4500 }),
    ];

    // ttl 2000: 0 miss, 1500 hit, 3000 miss (3000 - 0 > 2000), 4500 hit
    const result = simulateTtl(events, 2000);
    expect(result.hits).toBe(2);
    expect(result.misses).toBe(2);
  });

  it('handles an empty log', () => {
    const result = simulateTtl([], 3600_000);
    expect(result.total).toBe(0);
    expect(result.hitRate).toBe(0);
  });
});

describe('quantile', () => {
  it('interpolates', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([10], 0.5)).toBe(10);
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([0, 10, 20], 0.95)).toBeCloseTo(19);
  });
});

describe('summarize', () => {
  it('aggregates successes and computes TTL simulations', () => {
    const events = [
      event({ t: 0, upstreamMs: 100 }),
      event({ t: 1000, upstreamMs: 300 }),
      event({ t: 2000, upstreamMs: 500, status: 206 }),
    ];

    const summary = summarize(events, [3600_000, 86_400_000]);

    expect(summary.totalEvents).toBe(3);
    expect(summary.successful).toBe(2);
    expect(summary.bytes).toBe(2000);
    expect(summary.ttfb.p50).toBe(200);
    expect(summary.colos).toEqual([{ colo: 'SJC', requests: 2 }]);
    expect(summary.assets[0]?.asset).toBe('app.zip');
    expect(summary.ttls).toHaveLength(2);
    expect(summary.ttls[0]?.hits).toBe(1);
  });
});
