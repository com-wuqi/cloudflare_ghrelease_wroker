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

export interface TtlSimulation {
  ttlMs: number;
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
  originShare: number;
  bytesServed: number;
  bytesSaved: number;
}

export interface Summary {
  totalEvents: number;
  successful: number;
  bytes: number;
  ttfb: { p50: number; p95: number };
  handler: { p50: number; p95: number };
  assets: Array<{ asset: string; requests: number; bytes: number; colos: string[] }>;
  colos: Array<{ colo: string; requests: number }>;
  ttls: TtlSimulation[];
  firstEventAt: number;
  lastEventAt: number;
}

export function parseTailLines(text: string): DownloadEvent[];
export function simulateTtl(events: DownloadEvent[], ttlMs: number): TtlSimulation;
export function quantile(values: number[], q: number): number;
export function summarize(events: DownloadEvent[], ttlsMs: number[]): Summary;
