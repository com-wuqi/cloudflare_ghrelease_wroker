import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  DEPLOY_HOST,
  ORIGIN,
  REPO,
  githubAssetPath,
  registerRelease,
  route,
  routeWhere,
  upstreamCalls,
  useUpstreamMock,
} from './helpers';

useUpstreamMock();

const VERIFY_URL = `${ORIGIN}/api/verify`;
const ASSET = 'app-1.0.0.zip';
const SITEVERIFY_PATH = '/turnstile/v0/siteverify';

function mockSiteverify(body: Record<string, unknown>, status = 200) {
  route('challenges.cloudflare.com', SITEVERIFY_PATH, {
    status,
    headers: { 'content-type': 'application/json' },
    body: status === 200 ? JSON.stringify(body) : '',
  });
}

function verifyRequest(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return SELF.fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(payload),
  });
}

const GOOD_TOKEN = 'valid-turnstile-token-value';

describe('turnstile verification', () => {
  it('issues a session cookie on success', async () => {
    mockSiteverify({ success: true, hostname: 'example.com' });

    const response = await verifyRequest({ token: GOOD_TOKEN, next: `/dl/${REPO}/${ASSET}` });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; next: string };
    expect(body.ok).toBe(true);
    expect(body.next).toBe(`/dl/${REPO}/${ASSET}`);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('dl_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');

    // The issued cookie must actually unlock the download route.
    registerRelease();
    route('github.com', githubAssetPath(ASSET), { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a/b?x=1' } });
    routeWhere((url) => url.hostname === 'release-assets.githubusercontent.com', {
      status: 200,
      headers: { 'content-type': 'application/zip' },
      body: 'payload',
    });

    const token = cookie.slice('dl_session='.length).split(';')[0] ?? '';
    const download = await SELF.fetch(`${ORIGIN}/dl/${REPO}/${ASSET}`, {
      headers: { cookie: `dl_session=${token}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('payload');
  });

  it('accepts a token issued for this hostname', async () => {
    mockSiteverify({ success: true, hostname: DEPLOY_HOST });
    const response = await verifyRequest({ token: GOOD_TOKEN });
    expect(response.status).toBe(200);
  });

  it('rejects a failed verification and does not set a cookie', async () => {
    mockSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });

    const response = await verifyRequest({ token: GOOD_TOKEN });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ error: 'verification_failed' });
  });

  it('rejects a token issued for another hostname', async () => {
    mockSiteverify({ success: true, hostname: 'attacker.example' });

    const response = await verifyRequest({ token: GOOD_TOKEN });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ error: 'hostname_mismatch' });
  });

  it('rejects cross-origin submissions', async () => {
    mockSiteverify({ success: true, hostname: 'example.com' });

    const response = await verifyRequest(
      { token: GOOD_TOKEN },
      { origin: 'https://attacker.example' },
    );

    expect(response.status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('accepts a null origin produced by an http-to-https upgrade', async () => {
    mockSiteverify({ success: true, hostname: 'example.com' });

    const response = await verifyRequest({ token: GOOD_TOKEN }, { origin: 'null' });

    expect(response.status).toBe(200);
  });

  it('rejects short or missing tokens without calling siteverify', async () => {
    const short = await verifyRequest({ token: 'abc' });
    expect(short.status).toBe(400);

    const missing = await verifyRequest({});
    expect(missing.status).toBe(400);

    const wrongType = await verifyRequest({ token: 12345 });
    expect(wrongType.status).toBe(400);

    expect(upstreamCalls()).toHaveLength(0);
  });

  it('rejects a non-JSON body', async () => {
    const response = await SELF.fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: ORIGIN },
      body: 'not json',
    });
    expect(response.status).toBe(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('reports upstream siteverify failures as verification_failed', async () => {
    mockSiteverify({}, 500);
    const response = await verifyRequest({ token: GOOD_TOKEN });
    expect(response.status).toBe(401);
  });

  it('only accepts POST', async () => {
    const response = await SELF.fetch(VERIFY_URL);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('post-verification redirects', () => {
  it.each([
    ['//evil.example/path', '/'],
    ['https://evil.example/path', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['dl/relative', '/'],
    ['', '/'],
  ])('sanitises next=%s to %s', async (next, expected) => {
    mockSiteverify({ success: true, hostname: 'example.com' });

    const response = await verifyRequest({ token: GOOD_TOKEN, next });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { next: string };
    expect(body.next).toBe(expected);
  });

  it('keeps a same-origin download path with its query string', async () => {
    mockSiteverify({ success: true, hostname: 'example.com' });

    const response = await verifyRequest({
      token: GOOD_TOKEN,
      next: `/dl/${REPO}/${ASSET}?download=1`,
    });

    const body = (await response.json()) as { next: string };
    expect(body.next).toBe(`/dl/${REPO}/${ASSET}?download=1`);
  });
});
