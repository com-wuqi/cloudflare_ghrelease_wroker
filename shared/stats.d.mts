export interface TtlEvent {
  t: number;
  colo: string;
  repo: string;
  asset: string;
  size: number;
  status: number;
  range: boolean;
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

export function simulateTtl(events: TtlEvent[], ttlMs: number): TtlSimulation;
export function quantile(values: number[], q: number): number;
