/**
 * Numeric configuration helpers shared by every module that reads a var.
 * Invalid input falls back to a safe default; valid input is clamped so a
 * misconfigured deployment cannot disable a limit by setting it to zero.
 */

export function clampInt(
  raw: string | number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
