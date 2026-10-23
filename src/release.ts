/**
 * Latest-release metadata, cached in the Cloudflare edge cache.
 *
 * Unauthenticated GitHub API calls are limited to 60/hour per egress IP, so we
 * cache the parsed (and already validated) asset list for a few minutes and
 * keep serving the last known good copy for up to 24h if GitHub errors out.
 *
 * `loadRelease` never throws: it returns a machine-readable `failure` so the UI
 * and `/api/releases` can explain *why* GitHub was unreachable.
 */

import { isAllowedAssetUrl, isSafeName } from './lib/security';

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadCount: number;
  url: string;
}

export interface ReleaseInfo {
  fullName: string;
  tag: string;
  name: string;
  publishedAt: string;
  assets: ReleaseAsset[];
  fetchedAt: number;
}

export type ReleaseFailure =
  | 'rate_limited'
  | 'not_found'
  | 'unauthorized'
  | 'network'
  | 'invalid_response'
  | 'upstream_error';

export interface ReleaseResult {
  info: ReleaseInfo | null;
  failure: ReleaseFailure | null;
}

const CACHE_ORIGIN = 'https://release-metadata-cache.invalid';
const API_TIMEOUT_MS = 8000;
const STALE_FALLBACK_MS = 24 * 60 * 60 * 1000;

export function releaseCacheKey(fullName: string): string {
  return `${CACHE_ORIGIN}/v1/${encodeURIComponent(fullName.toLowerCase())}`;
}

function cacheTtlMs(env: Env): number {
  const seconds = Number.parseInt(env.RELEASE_CACHE_TTL ?? '300', 10);
  if (!Number.isFinite(seconds) || seconds < 0) return 300_000;
  return Math.min(seconds, 3600) * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function classifyStatus(status: number): ReleaseFailure {
  if (status === 403 || status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthorized';
  return 'upstream_error';
}

/**
 * GitHub release objects do NOT contain `full_name` (that is a repository
 * field). Identity is verified through `url` and `html_url`, which point at the
 * repo the release belongs to.
 */
function belongsToRepo(rawUrl: unknown, fullName: string, kind: 'api' | 'html'): boolean {
  if (typeof rawUrl !== 'string') return false;
  const expected =
    kind === 'api'
      ? `https://api.github.com/repos/${fullName.toLowerCase()}/releases/`
      : `https://github.com/${fullName.toLowerCase()}/releases/tag/`;
  return rawUrl.toLowerCase().startsWith(expected);
}

type FetchOutcome = { info: ReleaseInfo } | { failure: ReleaseFailure };

async function fetchLatest(env: Env, fullName: string): Promise<FetchOutcome> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'akeymux-release-gate (cloudflare worker)',
  };
  const hasToken = typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0;
  if (hasToken) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${fullName}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    console.error('github releases/latest network error', error);
    return { failure: 'network' };
  }

  if (!response.ok) {
    console.error('github releases/latest failed', {
      status: response.status,
      token: hasToken ? 'present' : 'missing',
      remaining: response.headers.get('x-ratelimit-remaining'),
      reset: response.headers.get('x-ratelimit-reset'),
      message: await response.text().catch(() => ''),
    });
    return { failure: classifyStatus(response.status) };
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(await response.json());
  } catch (error) {
    console.error('github releases/latest invalid json', error);
    return { failure: 'invalid_response' };
  }
  if (!payload) return { failure: 'invalid_response' };

  if (!belongsToRepo(payload.url, fullName, 'api')) return { failure: 'invalid_response' };
  if (!belongsToRepo(payload.html_url, fullName, 'html')) return { failure: 'invalid_response' };

  const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
  if (!tag) return { failure: 'invalid_response' };

  const assets: ReleaseAsset[] = [];
  if (Array.isArray(payload.assets)) {
    for (const entry of payload.assets) {
      const asset = asRecord(entry);
      if (!asset) continue;

      const name = typeof asset.name === 'string' ? asset.name : '';
      const rawUrl = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
      if (!isSafeName(name)) continue;

      const url = isAllowedAssetUrl(rawUrl, fullName);
      if (!url) continue;

      assets.push({
        name,
        size: typeof asset.size === 'number' && asset.size >= 0 ? asset.size : 0,
        downloadCount:
          typeof asset.download_count === 'number' && asset.download_count >= 0
            ? asset.download_count
            : 0,
        url: url.toString(),
      });
    }
  }

  return {
    info: {
      fullName,
      tag,
      name: typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : tag,
      publishedAt: typeof payload.published_at === 'string' ? payload.published_at : '',
      assets,
      fetchedAt: Date.now(),
    },
  };
}

export async function loadRelease(env: Env, fullName: string): Promise<ReleaseResult> {
  const cache = caches.default;
  const key = releaseCacheKey(fullName);

  let stored: ReleaseInfo | null = null;
  try {
    const cached = await cache.match(key);
    if (cached) stored = (await cached.json()) as ReleaseInfo;
  } catch (error) {
    console.error('release cache read failed', error);
    stored = null;
  }

  const now = Date.now();
  const ttl = cacheTtlMs(env);
  if (stored && ttl > 0 && now - stored.fetchedAt < ttl) return { info: stored, failure: null };

  const outcome = await fetchLatest(env, fullName);
  if ('info' in outcome) {
    try {
      await cache.put(
        key,
        new Response(JSON.stringify(outcome.info), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'max-age=86400',
          },
        }),
      );
    } catch (error) {
      // A cache failure must not break downloads.
      console.error('release cache write failed', error);
    }
    return { info: outcome.info, failure: null };
  }

  if (stored && now - stored.fetchedAt < STALE_FALLBACK_MS) {
    console.error('serving stale release metadata', outcome.failure);
    return { info: stored, failure: null };
  }
  return { info: null, failure: outcome.failure };
}

export function findAsset(info: ReleaseInfo, name: string): ReleaseAsset | null {
  for (const asset of info.assets) {
    if (asset.name === name) return asset;
  }
  return null;
}
