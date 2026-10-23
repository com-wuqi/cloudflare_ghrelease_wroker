import { afterAll, afterEach, beforeAll } from 'vitest';

import { signSession } from '../src/lib/auth';
import { releaseCacheKey } from '../src/release';

export const ORIGIN = 'https://dl.example.com';
export const DEPLOY_HOST = 'dl.example.com';
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef0123456789';
export const TEST_SITE_KEY = '1x00000000000000000000AA';
export const REPO = 'example/app';
export const OTHER_REPO = 'other-org/other-repo';

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Headers;
}

export interface MockResult {
  status?: number;
  headers?: Record<string, string>;
  body?: string | null;
}

export type RouteMatcher = (url: URL, method: string) => boolean;
export type RouteResponder = (url: URL, method: string) => MockResult | Promise<MockResult>;

interface RegisteredRoute {
  match: RouteMatcher;
  respond: RouteResponder;
}

const routes: RegisteredRoute[] = [];
const calls: UpstreamCall[] = [];

let originalFetch: typeof fetch | null = null;

export function upstreamCalls(): readonly UpstreamCall[] {
  return calls;
}

export function resetUpstream(): void {
  routes.length = 0;
  calls.length = 0;
}

/** Replace the global fetch so Worker-side outbound calls are intercepted. */
export function installUpstreamMock(): void {
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const method = (init?.method ?? 'GET').toUpperCase();

    calls.push({ url: url.toString(), method, headers: new Headers(init?.headers) });

    const route = routes.find((candidate) => candidate.match(url, method));
    if (!route) throw new Error(`unexpected upstream request: ${method} ${url}`);

    const result = await route.respond(url, method);
    return new Response(result.body ?? null, {
      status: result.status ?? 200,
      headers: result.headers,
    });
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub as typeof fetch;
}

export function restoreUpstreamMock(): void {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    originalFetch = null;
  }
}

/** Matches on hostname + exact pathname. */
export function route(
  host: string,
  pathname: string,
  result: MockResult | RouteResponder,
): void {
  routes.push({
    match: (url) => url.hostname === host && url.pathname === pathname,
    respond: typeof result === 'function' ? result : () => result,
  });
}

/** Matches on hostname only (or any predicate). */
export function routeWhere(
  predicate: RouteMatcher,
  result: MockResult | RouteResponder,
): void {
  routes.push({ match: predicate, respond: typeof result === 'function' ? result : () => result });
}

export function releaseFixture(
  assets: Array<{ name: string; size?: number }> = [{ name: 'app-1.0.0.zip' }],
  tag = 'v1.0.0',
): Record<string, unknown> {
  // Mirrors the real GitHub release schema: note there is no `full_name` field.
  return {
    url: `https://api.github.com/repos/${REPO}/releases/42`,
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    assets_url: `https://api.github.com/repos/${REPO}/releases/42/assets`,
    id: 42,
    tag_name: tag,
    target_commitish: 'main',
    name: `Release ${tag}`,
    draft: false,
    prerelease: false,
    created_at: '2026-10-20T11:00:00Z',
    published_at: '2026-10-20T12:00:00Z',
    assets: assets.map((asset) => ({
      name: asset.name,
      size: asset.size ?? 1024,
      download_count: 7,
      content_type: 'application/octet-stream',
      state: 'uploaded',
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(asset.name)}`,
    })),
  };
}

export function registerRelease(
  assets: Array<{ name: string; size?: number }> = [{ name: 'app-1.0.0.zip' }],
  tag = 'v1.0.0',
  repo = REPO,
): void {
  route('api.github.com', `/repos/${repo}/releases/latest`, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(releaseFixture(assets, tag)),
  });
}

export function githubAssetPath(asset: string, tag = 'v1.0.0', repo = REPO): string {
  return `/${repo}/releases/download/${tag}/${encodeURIComponent(asset)}`;
}

export async function sessionCookie(overrides?: {
  iat?: number;
  exp?: number;
  secret?: string;
  jti?: string;
  sub?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signSession(
    {
      iat: overrides?.iat ?? now,
      exp: overrides?.exp ?? now + 600,
      jti: overrides?.jti ?? 'a'.repeat(16),
      sub: overrides?.sub ?? '',
    },
    overrides?.secret ?? SESSION_SECRET,
  );
  return `dl_session=${token}`;
}

export function authHeaders(cookie: string, extra?: Record<string, string>): Record<string, string> {
  return { cookie, ...extra };
}

export function useUpstreamMock(): void {
  beforeAll(() => {
    installUpstreamMock();
  });
  afterEach(async () => {
    resetUpstream();
    // The edge cache is shared by every test in this file: drop it so a stale
    // fallback from a previous test cannot mask a mocked failure.
    await Promise.all(
      [REPO, OTHER_REPO].map((repo) => caches.default.delete(releaseCacheKey(repo))),
    );
  });
  afterAll(() => {
    restoreUpstreamMock();
  });
}
