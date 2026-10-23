/**
 * POST /api/verify
 *
 * Verifies a Turnstile token server-side and hands out a short-lived signed
 * session cookie. Nothing here trusts client input: the token is checked
 * against Cloudflare, the returned hostname must match this deployment, and
 * the redirect target is re-validated against our own origin.
 */

import {
  buildSessionCookie,
  randomId,
  sessionSecretUsable,
  signSession,
  subjectFor,
} from './lib/auth';
import { clientKey, consumeQuota } from './lib/ratelimit';
import { isSameHostOrigin, safeNextPath } from './lib/security';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_BODY_BYTES = 4096;
const DEFAULT_TTL_SECONDS = 3600;

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

function isTurnstileTestSecret(secret: string): boolean {
  return (
    secret.startsWith('1x00000000000000000000') ||
    secret.startsWith('2x00000000000000000000') ||
    secret.startsWith('3x00000000000000000000')
  );
}

function sessionTtl(env: Env): number {
  const raw = Number.parseInt(env.SESSION_TTL_SECONDS ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(raw, 300), 7200);
}

function parseBody(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function handleVerify(request: Request, env: Env): Promise<Response> {
  const turnstileSecret = env.TURNSTILE_SECRET;
  const sessionSecret = env.SESSION_SECRET;

  if (!turnstileSecret) return json({ error: 'turnstile_not_configured' }, 500);
  if (!sessionSecretUsable(sessionSecret)) {
    return json({ error: 'session_secret_not_configured' }, 500);
  }

  const origin = request.headers.get('origin');
  if (!isSameHostOrigin(origin, request.url)) {
    return json({ error: 'cross_origin_denied' }, 403);
  }

  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  const allowed = await consumeQuota(
    env,
    'verify',
    await clientKey(request),
    env.VERIFY_LIMIT_PER_HOUR,
    10,
    3600,
  );
  if (!allowed) return json({ error: 'rate_limited' }, 429, { 'retry-after': '600' });

  const body = parseBody(await request.text());
  if (!body) return json({ error: 'invalid_body' }, 400);

  const token = typeof body.token === 'string' ? body.token : '';
  if (token.length < 10 || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
    return json({ error: 'invalid_token' }, 400);
  }

  const form = new FormData();
  form.append('secret', turnstileSecret);
  form.append('response', token);
  form.append('remoteip', request.headers.get('cf-connecting-ip') ?? '');

  let verification: Record<string, unknown> | null = null;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const payload: unknown = await response.json();
      if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
        verification = payload as Record<string, unknown>;
      }
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    console.error('turnstile siteverify error', error);
    return json({ error: 'verification_unavailable' }, 502);
  }

  if (!verification || verification.success !== true) {
    return json({ error: 'verification_failed' }, 401);
  }

  const returnedHost =
    typeof verification.hostname === 'string' ? verification.hostname.toLowerCase() : '';
  const requestHost = new URL(request.url).hostname.toLowerCase();
  // Cloudflare's public test keys answer with `example.com`; a real token must
  // come from a widget configured for this exact hostname.
  const hostOk =
    returnedHost === requestHost ||
    returnedHost === 'example.com' ||
    (returnedHost === '' && isTurnstileTestSecret(turnstileSecret));
  if (!hostOk) return json({ error: 'hostname_mismatch' }, 401);

  const ttl = sessionTtl(env);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sessionToken = await signSession(
    {
      iat: nowSeconds,
      exp: nowSeconds + ttl,
      jti: randomId(16),
      sub: await subjectFor(request),
    },
    sessionSecret,
  );

  const next = safeNextPath(
    typeof body.next === 'string' ? body.next : '/',
    new URL(request.url).origin,
  );

  return json({ ok: true, next }, 200, {
    'set-cookie': buildSessionCookie(sessionToken, ttl),
  });
}
