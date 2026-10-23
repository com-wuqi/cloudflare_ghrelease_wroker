/** Admin authentication + stats endpoints. No download session can reach these. */

import {
  ADMIN_COOKIE,
  ADMIN_MAX_TTL_SECONDS,
  buildAdminCookie,
  buildClearAdminCookie,
  readCookie,
  sessionSecretUsable,
  signAdminSession,
  verifyAdminSession,
} from './lib/auth';
import { clientKey, consumeQuota } from './lib/ratelimit';
import { isSameHostOrigin } from './lib/security';
import type { MetricsStub, MetricsSummary } from './metrics-do';
import {
  RANGES,
  renderAdminLogin,
  renderAdminPage,
  renderAdminUnavailable,
  type RangeOption,
} from './ui-admin';

const MIN_ADMIN_TOKEN_LENGTH = 16;
const MAX_LOGIN_BODY = 4096;
const encoder = new TextEncoder();

function adminEnabled(env: Env): boolean {
  return (
    typeof env.ADMIN_TOKEN === 'string' && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN_LENGTH
  );
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Compares SHA-256 digests in constant time (WebCrypto has no timingSafeEqual). */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      allow,
      'cache-control': 'no-store',
    },
  });
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function parseRange(raw: string | null): RangeOption {
  return RANGES.find((option) => option.key === raw) ?? { key: '7d', days: 7 };
}

async function hasAdminSession(request: Request, env: Env): Promise<boolean> {
  if (!sessionSecretUsable(env.SESSION_SECRET)) return false;
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return false;
  return verifyAdminSession(token, env.SESSION_SECRET);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!isSameHostOrigin(origin, request.url)) {
    console.error('admin login origin mismatch', { origin, url: request.url });
    return renderAdminLogin('来源不被允许。', 403);
  }

  const allowed = await consumeQuota(
    env,
    'admin',
    await clientKey(request),
    env.ADMIN_LIMIT_PER_HOUR,
    10,
    3600,
  );
  if (!allowed) return renderAdminLogin('尝试次数过多，请稍后再试。', 429);

  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > MAX_LOGIN_BODY) {
    return renderAdminLogin('请求过大。', 413);
  }

  let provided = '';
  try {
    const form = await request.formData();
    const value = form.get('token');
    provided = typeof value === 'string' ? value : '';
  } catch {
    return renderAdminLogin('Token 不正确。');
  }

  if (provided.length === 0 || provided.length > 512) {
    return renderAdminLogin('Token 不正确。');
  }

  const expected = env.ADMIN_TOKEN ?? '';
  if (!(await constantTimeEqual(provided, expected))) {
    return renderAdminLogin('Token 不正确。');
  }

  if (!sessionSecretUsable(env.SESSION_SECRET)) {
    return new Response('server_misconfigured', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const token = await signAdminSession(env.SESSION_SECRET, ADMIN_MAX_TTL_SECONDS);
  return redirect('/admin', buildAdminCookie(token, ADMIN_MAX_TTL_SECONDS));
}

async function loadSummary(env: Env, days: number): Promise<MetricsSummary | null> {
  if (!env.METRICS) return null;
  try {
    const stub = env.METRICS.get(
      env.METRICS.idFromName('global'),
    ) as unknown as MetricsStub;
    return await stub.summary(days);
  } catch (error) {
    console.error('metrics summary failed', error);
    return null;
  }
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvResponse(summary: MetricsSummary, range: RangeOption): Response {
  const lines = ['asset,tag,requests,bytes,colos,hit_1h,hit_6h,hit_24h,origin_24h'];
  for (const asset of summary.assets) {
    lines.push(
      [
        csvCell(asset.asset),
        csvCell(asset.tag),
        asset.requests,
        asset.bytes,
        csvCell(asset.colos.join(' ')),
        (asset.ttls[0]?.hitRate ?? 0).toFixed(4),
        (asset.ttls[1]?.hitRate ?? 0).toFixed(4),
        (asset.ttls[2]?.hitRate ?? 0).toFixed(4),
        (asset.ttls[2]?.originShare ?? 0).toFixed(4),
      ].join(','),
    );
  }

  return new Response(`\uFEFF${lines.join('\r\n')}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="download-stats-${range.key}.csv"`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!adminEnabled(env)) return notFound();

  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === '/admin/login') {
    if (method === 'GET' || method === 'HEAD') return renderAdminLogin();
    if (method !== 'POST') return methodNotAllowed('GET, HEAD, POST');
    return handleLogin(request, env);
  }

  if (path === '/admin/logout') {
    return redirect('/admin/login', buildClearAdminCookie());
  }

  if (!(await hasAdminSession(request, env))) return redirect('/admin/login');

  if (path === '/admin' || path === '/admin/') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const range = parseRange(url.searchParams.get('range'));
    const summary = await loadSummary(env, range.days);
    if (!summary) return renderAdminUnavailable();
    return renderAdminPage(summary, range);
  }

  if (path === '/admin/export.csv') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const range = parseRange(url.searchParams.get('range'));
    const summary = await loadSummary(env, range.days);
    if (!summary) return renderAdminUnavailable();
    return csvResponse(summary, range);
  }

  if (path === '/admin/data.json') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const range = parseRange(url.searchParams.get('range'));
    const summary = await loadSummary(env, range.days);
    if (!summary) return renderAdminUnavailable();
    return jsonResponse({ range: range.key, summary });
  }

  return notFound();
}
