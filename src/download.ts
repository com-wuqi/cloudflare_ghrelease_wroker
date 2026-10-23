/**
 * GET|HEAD /dl/{owner}/{repo}/{asset}
 *
 * The gate has already been checked by the router. This module additionally
 * verifies that the requested asset really exists in the latest release, then
 * streams it from GitHub while validating every redirect hop.
 */

import { clientKey, consumeQuota } from './lib/ratelimit';
import {
  contentDisposition,
  isAllowedAssetUrl,
  resolveAllowedRedirect,
  sanitizeRange,
} from './lib/security';
import { findAsset, loadRelease, type ReleaseAsset } from './release';

const MAX_REDIRECTS = 3;
const USER_AGENT = 'akeymux-release-gate (cloudflare worker)';

function errorResponse(
  status: number,
  code: string,
  extraHeaders?: HeadersInit,
  details?: Record<string, unknown>,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify({ error: code, ...details }), { status, headers });
}

function buildUpstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set('user-agent', USER_AGENT);
  // Never let a client-requested encoding mangle a binary body.
  headers.set('accept-encoding', 'identity');
  const range = sanitizeRange(request.headers.get('range'));
  if (range) headers.set('range', range);
  return headers;
}

function toClientResponse(upstream: Response, asset: ReleaseAsset, method: string): Response {
  const headers = new Headers();

  const contentType = upstream.headers.get('content-type');
  headers.set('content-type', contentType ?? 'application/octet-stream');

  const length = upstream.headers.get('content-length');
  if (length && /^\d{1,19}$/.test(length)) headers.set('content-length', length);

  const contentRange = upstream.headers.get('content-range');
  if (contentRange && /^bytes \d{1,19}-\d{1,19}\/\d{1,19}$/.test(contentRange)) {
    headers.set('content-range', contentRange);
  }

  const acceptRanges = upstream.headers.get('accept-ranges');
  if (acceptRanges === 'bytes') headers.set('accept-ranges', 'bytes');

  const etag = upstream.headers.get('etag');
  if (etag && /^[\x20-\x7e]{1,200}$/.test(etag)) headers.set('etag', etag);

  const lastModified = upstream.headers.get('last-modified');
  if (lastModified && /^[\x20-\x7e]{1,100}$/.test(lastModified)) {
    headers.set('last-modified', lastModified);
  }

  headers.set('content-disposition', contentDisposition(asset.name));
  headers.set('cache-control', 'private, max-age=0, no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; sandbox");
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-robots-tag', 'noindex, nofollow');

  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function handleDownload(
  request: Request,
  env: Env,
  fullName: string,
  assetName: string,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return errorResponse(405, 'method_not_allowed', { allow: 'GET, HEAD' });
  }

  const allowed = await consumeQuota(
    env,
    'dl',
    await clientKey(request),
    env.DOWNLOAD_LIMIT_PER_HOUR,
    200,
    3600,
  );
  if (!allowed) return errorResponse(429, 'rate_limited', { 'retry-after': '600' });

  const release = await loadRelease(env, fullName);
  if (!release.info) {
    return errorResponse(502, 'release_unavailable', undefined, {
      reason: release.failure ?? 'upstream_error',
    });
  }

  const asset = findAsset(release.info, assetName);
  if (!asset) return errorResponse(404, 'asset_not_found');

  const target = isAllowedAssetUrl(asset.url, release.info.fullName);
  if (!target) return errorResponse(502, 'invalid_asset_url');

  const upstreamHeaders = buildUpstreamHeaders(request);
  let current = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let upstream: Response;
    try {
      upstream = await fetch(current.toString(), {
        method,
        headers: upstreamHeaders,
        redirect: 'manual',
      });
    } catch (error) {
      console.error('upstream download unreachable', error);
      return errorResponse(502, 'upstream_unreachable');
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      const next = resolveAllowedRedirect(upstream.headers.get('location'), current);
      if (!next) {
        console.error('blocked upstream redirect', upstream.status, upstream.headers.get('location'));
        return errorResponse(502, 'blocked_redirect');
      }
      current = next;
      continue;
    }

    if (!upstream.ok && upstream.status !== 416) {
      await upstream.body?.cancel();
      console.error('upstream download failed', upstream.status);
      return errorResponse(502, 'upstream_error');
    }

    const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/html')) {
      await upstream.body?.cancel();
      return errorResponse(502, 'unexpected_content_type');
    }

    return toClientResponse(upstream, asset, method);
  }

  return errorResponse(502, 'too_many_redirects');
}
