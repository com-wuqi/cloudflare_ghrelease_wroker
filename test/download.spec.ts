import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  authHeaders,
  githubAssetPath,
  ORIGIN,
  REPO,
  registerRelease,
  releaseFixture,
  route,
  routeWhere,
  sessionCookie,
  upstreamCalls,
  useUpstreamMock,
} from './helpers';

useUpstreamMock();

const ASSET = 'app-1.0.0.zip';
const ASSET_URL = `${ORIGIN}/dl/${REPO}/${ASSET}`;
const ASSET_HOST =
  'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=abc';

function registerDownload(
  body = 'hello world',
  extraHeaders: Record<string, string> = {},
  status = 200,
) {
  route('github.com', githubAssetPath(ASSET), {
    status: 302,
    headers: { location: ASSET_HOST },
  });
  routeWhere((url) => url.hostname === 'release-assets.githubusercontent.com', {
    status,
    headers: { 'content-type': 'application/zip', ...extraHeaders },
    body,
  });
}

describe('download gate', () => {
  it('rejects a request without a session and never touches upstream', async () => {
    const response = await SELF.fetch(ASSET_URL, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'verification_required' });
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('shows the Turnstile gate for browsers without a session', async () => {
    const response = await SELF.fetch(ASSET_URL, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('cf-turnstile');
    expect(html).toContain('data-sitekey="1x00000000000000000000AA"');
    expect(html).toContain(`value="/dl/${REPO}/${ASSET}"`);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('streams the asset for a valid session', async () => {
    registerRelease();
    registerDownload();

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello world');
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('cache-control')).toBe('private, max-age=0, no-store');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain(ASSET);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // The intermediate github.com URL must not leak to the browser.
    expect(response.headers.get('location')).toBeNull();
    expect(upstreamCalls().map((call) => call.url)).toEqual([
      `https://api.github.com/repos/${REPO}/releases/latest`,
      `https://github.com${githubAssetPath(ASSET)}`,
      ASSET_HOST,
    ]);
  });

  it('forwards a single Range request and returns 206', async () => {
    registerRelease();
    registerDownload(
      'partial',
      {
        'content-range': 'bytes 0-6/11',
        'content-length': '7',
      },
      206,
    );

    const response = await SELF.fetch(ASSET_URL, {
      headers: authHeaders(await sessionCookie(), { range: 'bytes=0-6' }),
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-6/11');
    const assetCall = upstreamCalls().find(
      (call) => call.url === `https://github.com${githubAssetPath(ASSET)}`,
    );
    expect(assetCall?.headers.get('range')).toBe('bytes=0-6');
    expect(assetCall?.headers.get('accept-encoding')).toBe('identity');
  });

  it('drops malformed and multi-range headers', async () => {
    registerRelease();
    registerDownload();

    await SELF.fetch(ASSET_URL, {
      headers: authHeaders(await sessionCookie(), { range: 'bytes=0-1,3-4' }),
    });

    const assetCall = upstreamCalls().find(
      (call) => call.url === `https://github.com${githubAssetPath(ASSET)}`,
    );
    expect(assetCall?.headers.get('range')).toBeNull();
  });

  it('returns 404 for an asset that is not in the latest release', async () => {
    registerRelease();

    const response = await SELF.fetch(`${ORIGIN}/dl/${REPO}/not-a-real-asset.exe`, {
      headers: authHeaders(await sessionCookie()),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'asset_not_found' });
    expect(upstreamCalls()).toHaveLength(1);
  });

  it('blocks an upstream redirect to a non-GitHub host', async () => {
    registerRelease();
    route('github.com', githubAssetPath(ASSET), {
      status: 302,
      headers: { location: 'https://evil.example.com/payload.zip' },
    });

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'blocked_redirect' });
    expect(upstreamCalls().some((call) => call.url.includes('evil.example.com'))).toBe(false);
    expect(upstreamCalls()).toHaveLength(2);
  });

  it('blocks a lookalike githubusercontent host', async () => {
    registerRelease();
    route('github.com', githubAssetPath(ASSET), {
      status: 302,
      headers: { location: 'https://evil-githubusercontent.com/payload.zip' },
    });

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });
    expect(response.status).toBe(502);
    expect(upstreamCalls()).toHaveLength(2);
  });

  it('gives up after too many redirects', async () => {
    registerRelease();
    let hop = 0;
    routeWhere(
      (url) => url.hostname === 'github.com',
      () => {
        hop += 1;
        return {
          status: 302,
          headers: { location: `https://github.com/${REPO}/releases/download/v1.0.0/loop-${hop}` },
        };
      },
    );

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'too_many_redirects' });
    expect(hop).toBe(4);
  });

  it('maps upstream failures to 502', async () => {
    registerRelease();
    route('github.com', githubAssetPath(ASSET), { status: 404, body: 'nope' });

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });
    expect(response.status).toBe(502);
  });

  it('refuses to serve an HTML page pretending to be an asset', async () => {
    registerRelease();
    route('github.com', githubAssetPath(ASSET), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html>login</html>',
    });

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'unexpected_content_type' });
  });

  it('reports why the release metadata is unavailable', async () => {
    route('api.github.com', `/repos/${REPO}/releases/latest`, { status: 403, body: '' });

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'release_unavailable',
      reason: 'rate_limited',
    });
  });

  it('rejects release metadata that belongs to another repository', async () => {
    route('api.github.com', `/repos/${REPO}/releases/latest`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...releaseFixture(),
        html_url: 'https://github.com/evil-org/evil-repo/releases/tag/v1.0.0',
      }),
    });

    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(await sessionCookie()) });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'release_unavailable',
      reason: 'invalid_response',
    });
  });

  it('supports HEAD without a body', async () => {
    registerRelease();
    registerDownload();

    const response = await SELF.fetch(ASSET_URL, {
      method: 'HEAD',
      headers: authHeaders(await sessionCookie()),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(upstreamCalls()[1]?.method).toBe('HEAD');
  });
});
