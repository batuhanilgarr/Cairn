export type Latency = { min: number; mean: number; p50: number; p90: number; p95: number; p99: number; max: number };
/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export function latencyOf(ms: number[]): Latency | null {
  if (!ms.length) return null;
  const s = [...ms].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { min: s[0], mean: sum / s.length, p50: percentile(s, 0.5), p90: percentile(s, 0.9), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: s[s.length - 1] };
}

