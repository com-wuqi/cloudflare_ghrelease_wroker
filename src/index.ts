/**
 * Router. Fail-closed by default: every route that can reach GitHub requires a
 * valid signed session, except the verification endpoint and public assets.
 */

import { APP_JS, STYLE_CSS } from './assets';
import { handleAdmin } from './admin';
import { buildClearCookie, readCookie, SESSION_COOKIE, sessionSecretUsable, subjectFor, verifySession, type Session } from './lib/auth';
import { matchRepo, parseRepoList, pathSegments, safeNextPath } from './lib/security';
import { handleDownload } from './download';
import { loadRelease } from './release';
import { handleVerify } from './verify';
import { renderConfigError, renderGate, renderHome, type RepoView } from './ui';

function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

function textResponse(text: string, status: number, contentType: string): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  });
}

function methodNotAllowed(allow = 'GET, HEAD, POST'): Response {
  return jsonResponse({ error: 'method_not_allowed' }, 405, { allow });
}

function notFound(): Response {
  return jsonResponse({ error: 'not_found' }, 404);
}

function wantsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('text/html');
}

async function readSession(request: Request, env: Env): Promise<Session | null> {
  if (!sessionSecretUsable(env.SESSION_SECRET)) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return null;

  if (env.SESSION_BIND_IP === '1') {
    if (session.sub !== (await subjectFor(request))) return null;
  }
  return session;
}

async function homePage(views: RepoView[], session: Session): Promise<Response> {
  const remaining = Math.max(1, Math.round((session.exp - Date.now() / 1000) / 60));
  return renderHome({ views, sessionMinutes: remaining });
}

async function buildViews(env: Env, repos: readonly string[]): Promise<RepoView[]> {
  const views: RepoView[] = [];
  for (const repo of repos) {
    const result = await loadRelease(env, repo);
    views.push({ repo, info: result.info, failure: result.failure });
  }
  return views;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    LOCAL_HOSTS.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.test')
  );
}

/**
 * The session cookie is `Secure`, so plain HTTP can never hold a session and
 * would loop between "verify" and "no cookie". Upgrade before any other work.
 *
 * Only edge-provided signals (X-Forwarded-Proto / CF-Visitor) are trusted, so
 * `wrangler dev` (which rewrites request.url to the production hostname) and
 * tests are never redirected.
 */
function shouldUpgradeToHttps(request: Request, url: URL): boolean {
  if (isLocalHost(url.hostname)) return false;

  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim().toLowerCase() === 'http';

  const visitor = request.headers.get('cf-visitor');
  if (visitor) {
    try {
      const parsed = JSON.parse(visitor) as { scheme?: unknown };
      return parsed.scheme === 'http';
    } catch {
      return false;
    }
  }

  return false;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (shouldUpgradeToHttps(request, url)) {
    const secure = new URL(url.toString());
    secure.protocol = 'https:';
    return new Response(null, {
      status: 308,
      headers: { location: secure.toString(), 'cache-control': 'no-store' },
    });
  }

  if (method === 'OPTIONS') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD, POST' });
  }
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return methodNotAllowed();

  // ---- public static routes -------------------------------------------------
  if (pathname === '/robots.txt') {
    return textResponse('User-agent: *\nDisallow: /\n', 200, 'text/plain; charset=utf-8');
  }
  if (pathname === '/assets/app.js') {
    return new Response(APP_JS, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=600',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (pathname === '/assets/style.css') {
    return new Response(STYLE_CSS, {
      headers: {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'public, max-age=600',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (pathname === '/healthz') {
    return jsonResponse({ ok: true });
  }
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return handleAdmin(request, env, url);
  }
  if (pathname === '/logout') {
    return new Response(null, {
      status: 302,
      headers: { location: '/', 'set-cookie': buildClearCookie(), 'cache-control': 'no-store' },
    });
  }

  // ---- gate ----------------------------------------------------------------
  const repos = parseRepoList(env.REPOS);
  const secretReady = sessionSecretUsable(env.SESSION_SECRET);

  if (pathname === '/api/verify') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleVerify(request, env);
  }

  if (pathname === '/') {
    if (method === 'POST') return methodNotAllowed('GET, HEAD');
    if (!secretReady) return renderConfigError('SESSION_SECRET 未配置或长度不足 32 个字符。');
    if (repos.length === 0) return renderConfigError('REPOS 未配置任何仓库白名单。');
    if (!env.TURNSTILE_SECRET) return renderConfigError('TURNSTILE_SECRET 未配置。');

    const session = await readSession(request, env);
    if (!session) return renderGate({ siteKey: env.TURNSTILE_SITE_KEY, next: '/' });
    return homePage(await buildViews(env, repos), session);
  }

  if (pathname === '/api/releases') {
    if (method !== 'GET') return methodNotAllowed('GET, HEAD');
    if (!secretReady) return jsonResponse({ error: 'server_misconfigured' }, 500);
    const session = await readSession(request, env);
    if (!session) return jsonResponse({ error: 'verification_required' }, 401);

    const payload: Array<Record<string, unknown>> = [];
    for (const view of await buildViews(env, repos)) {
      const info = view.info;
      if (!info) {
        payload.push({
          repo: view.repo,
          error: 'unavailable',
          reason: view.failure ?? 'upstream_error',
        });
        continue;
      }
      payload.push({
        repo: info.fullName,
        tag: info.tag,
        name: info.name,
        publishedAt: info.publishedAt,
        assets: info.assets.map((asset) => ({
          name: asset.name,
          size: asset.size,
          downloadCount: asset.downloadCount,
          path: `/dl/${info.fullName}/${encodeURIComponent(asset.name)}`,
        })),
      });
    }
    return jsonResponse({ releases: payload });
  }

  if (pathname === '/dl' || pathname.startsWith('/dl/')) {
    if (method === 'POST') return methodNotAllowed('GET, HEAD');
    if (!secretReady) return jsonResponse({ error: 'server_misconfigured' }, 500);

    const session = await readSession(request, env);
    if (!session) {
      if (wantsHtml(request)) {
        return renderGate({ siteKey: env.TURNSTILE_SITE_KEY, next: safeNextPath(`${pathname}${url.search}`, url.origin) });
      }
      return jsonResponse({ error: 'verification_required' }, 401);
    }

    const parts = pathSegments(pathname);
    if (!parts || parts.length !== 4) return notFound();
    const [head, owner, repo, asset] = parts;
    if (head !== 'dl' || !owner || !repo || !asset) return notFound();

    const canonical = matchRepo(repos, owner, repo);
    if (!canonical) return jsonResponse({ error: 'repo_not_allowed' }, 404);

    return handleDownload(request, env, canonical, asset);
  }

  return notFound();
}

function finalize(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');

  const forwardedProto = request.headers.get('x-forwarded-proto');
  const isHttps = forwardedProto
    ? forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https'
    : new URL(request.url).protocol === 'https:';
  if (isHttps) headers.set('strict-transport-security', 'max-age=31536000');

  const body = request.method === 'HEAD' ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return finalize(request, await route(request, env));
    } catch (error) {
      console.error('unhandled worker error', error);
      return finalize(request, jsonResponse({ error: 'internal_error' }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

export { MetricsDO } from './metrics-do';
