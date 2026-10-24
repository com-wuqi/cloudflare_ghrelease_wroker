/**
 * GET|HEAD /dl/{owner}/{repo}/{asset}
 *
 * The gate has already been checked by the router. This module additionally
 * verifies that the requested asset really exists in the latest release, then
 * streams it from GitHub while validating every redirect hop.
 */

import { jsonResponse } from './lib/http';
import { requestLogContext } from './lib/log';
import { clientKey, consumeQuota } from './lib/ratelimit';
import {
  contentDisposition,
  isAllowedAssetUrl,
  resolveAllowedRedirect,
  sanitizeRange,
} from './lib/security';
import type { MetricEvent } from './metrics-do';
import { findAsset, loadRelease, type ReleaseAsset } from './release';

const MAX_REDIRECTS = 3;
/** Abort only the wait for response headers; an established stream may run as long as it needs. */
const UPSTREAM_HEADER_TIMEOUT_MS = 30_000;
const USER_AGENT = 'akeymux-release-gate (cloudflare worker)';

function errorResponse(
  status: number,
  code: string,
  extraHeaders?: HeadersInit,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse({ error: code, ...details }, status, extraHeaders);
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
  ctx: ExecutionContext,
  fullName: string,
  assetName: string,
): Promise<Response> {
  const startedAt = Date.now();
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

  const release = await loadRelease(env, fullName, requestLogContext(request));
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
  const fetchStartedAt = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let upstream: Response;
    const controller = new AbortController();
    let timedOut = false;
    const headerTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, UPSTREAM_HEADER_TIMEOUT_MS);
    try {
      upstream = await fetch(current.toString(), {
        method,
        headers: upstreamHeaders,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      console.error(
        'upstream download unreachable',
        { ...requestLogContext(request), repo: fullName, asset: assetName, timedOut },
        error,
      );
      return errorResponse(502, 'upstream_unreachable');
    } finally {
      // Headers are in (or the request failed): do not abort the body stream.
      clearTimeout(headerTimer);
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      const next = resolveAllowedRedirect(upstream.headers.get('location'), current);
      if (!next) {
        console.error('blocked upstream redirect', {
          ...requestLogContext(request),
          repo: fullName,
          asset: assetName,
          status: upstream.status,
          location: upstream.headers.get('location'),
        });
        return errorResponse(502, 'blocked_redirect');
      }
      current = next;
      continue;
    }

    if (!upstream.ok && upstream.status !== 416) {
      await upstream.body?.cancel();
      console.error('upstream download failed', {
        ...requestLogContext(request),
        repo: fullName,
        asset: assetName,
        status: upstream.status,
      });
      return errorResponse(502, 'upstream_error');
    }

    const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/html')) {
      await upstream.body?.cancel();
      console.error('unexpected upstream content type', {
        ...requestLogContext(request),
        repo: fullName,
        asset: assetName,
        contentType,
      });
      return errorResponse(502, 'unexpected_content_type');
    }

    const metric = buildMetric(request, {
      repo: release.info.fullName,
      tag: release.info.tag,
      asset: asset.name,
      size: asset.size,
      status: upstream.status,
      range: upstreamHeaders.has('range'),
      redirects: hop,
      upstreamMs: Date.now() - fetchStartedAt,
      handlerMs: Date.now() - startedAt,
    });

    // Best effort: never make the download wait on the metrics round-trip.
    // Best effort: never make the download wait on the metrics round-trip.
    ctx.waitUntil(recordMetric(env, metric, request));
    console.log(JSON.stringify({ evt: 'dl', ...metric }));

    return toClientResponse(upstream, asset, method);
  }

  return errorResponse(502, 'too_many_redirects');
}

interface DownloadInput {
  repo: string;
  tag: string;
  asset: string;
  size: number;
  status: number;
  range: boolean;
  redirects: number;
  upstreamMs: number;
  handlerMs: number;
}

/**
 * One structured event per authorized download. Consumed by the admin
 * dashboard (Durable Object) and scripts/analyze-logs.mjs. Never includes IPs,
 * cookies or tokens; `colo` / `country` / `asn` come from request.cf.
 */
function buildMetric(request: Request, input: DownloadInput): MetricEvent {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  return {
    ts: Date.now(),
    colo: typeof cf?.colo === 'string' ? cf.colo : 'unknown',
    country: typeof cf?.country === 'string' ? cf.country : 'unknown',
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
    ...input,
  };
}

/** Best effort: a metrics failure must never affect the download. */
export async function recordMetric(env: Env, event: MetricEvent, request?: Request): Promise<void> {
  if (!env.METRICS) return;
  try {
    const stub = env.METRICS.get(env.METRICS.idFromName('global'));
    await stub.record(event);
  } catch (error) {
    console.error('metrics record failed', request ? requestLogContext(request) : {}, error);
  }
}
