export type { TtlEvent, TtlSimulation } from '../../shared/stats.mjs';
export { quantile, simulateTtl } from '../../shared/stats.mjs';

export interface DownloadEvent {
  t: number;
  colo: string;
  country: string;
  asn: number | null;
  repo: string;
  tag: string;
  asset: string;
  size: number;
  status: number;
  range: boolean;
  upstreamMs: number;
  handlerMs: number;
}

export interface Summary {
  totalEvents: number;
  successful: number;
  bytes: number;
  ttfb: { p50: number; p95: number };
  handler: { p50: number; p95: number };
  assets: Array<{ repo: string; asset: string; requests: number; bytes: number; colos: string[] }>;
  colos: Array<{ colo: string; requests: number }>;
  ttls: import('../../shared/stats.mjs').TtlSimulation[];
  firstEventAt: number;
  lastEventAt: number;
}

export function parseTailLines(text: string): DownloadEvent[];
export function summarize(events: DownloadEvent[], ttlsMs: number[]): Summary;
