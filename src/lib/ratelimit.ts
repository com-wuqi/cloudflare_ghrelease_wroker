/**
 * Best-effort per-IP rate limiting on top of KV.
 *
 * The authentication gate does not depend on this module: it is purely an
 * anti-abuse control, so a KV outage must not lock users out.
 */

export function clientIp(request: Request): string {
  const header = request.headers.get('cf-connecting-ip');
  if (header && /^[0-9a-fA-F:.]{3,45}$/.test(header)) return header;
  return 'unknown';
}

export async function clientKey(request: Request): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`ratelimit\n${clientIp(request)}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, 100000);
}

/**
 * Returns `true` when the caller is still inside its quota.
 * Missing KV binding => limiter disabled (fail open, by design).
 */
export async function consumeQuota(
  env: Env,
  bucket: string,
  key: string,
  limitRaw: string | undefined,
  fallbackLimit: number,
  windowSeconds: number,
): Promise<boolean> {
  const kv = env.RATE_LIMIT;
  if (!kv) return true;

  const limit = positiveInt(limitRaw, fallbackLimit);
  const slot = Math.floor(Date.now() / 1000 / windowSeconds);
  const storageKey = `${bucket}:${key}:${slot}`;

  const stored = await kv.get(storageKey);
  const current = Number.parseInt(stored ?? '0', 10);
  if (Number.isFinite(current) && current >= limit) return false;

  await kv.put(storageKey, String((Number.isFinite(current) ? current : 0) + 1), {
    expirationTtl: windowSeconds + 60,
  });
  return true;
}
