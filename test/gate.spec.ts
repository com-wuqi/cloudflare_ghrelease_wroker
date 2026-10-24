import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  authHeaders,
  ORIGIN,
  OTHER_REPO,
  REPO,
  registerRelease,
  route,
  sessionCookie,
  upstreamCalls,
  useUpstreamMock,
} from './helpers';

useUpstreamMock();

const ASSET = 'app-1.0.0.zip';
const ASSET_URL = `${ORIGIN}/dl/${REPO}/${ASSET}`;

describe('session gate', () => {
  it('rejects a forged signature', async () => {
    const response = await SELF.fetch(ASSET_URL, {
      headers: authHeaders('dl_session=v1.1700000000.1700000600.aaaaaaaaaaaaaaaa..deadbeef'),
    });
    expect(response.status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('rejects a tampered payload', async () => {
    const cookie = await sessionCookie();
    const raw = cookie.slice('dl_session='.length);
    const parts = raw.split('.');
    const exp = Number(parts[2] ?? '0');
    parts[2] = String(exp + 3600);

    const response = await SELF.fetch(ASSET_URL, {
      headers: authHeaders(`dl_session=${parts.join('.')}`),
    });
    expect(response.status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('rejects a session signed with a different secret', async () => {
    const cookie = await sessionCookie({ secret: 'another-secret-0123456789abcdef0123456789' });
    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(cookie) });
    expect(response.status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = await sessionCookie({ iat: now - 1000, exp: now - 500 });
    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(cookie) });
    expect(response.status).toBe(401);
  });

  it('rejects an unknown session version', async () => {
    const cookie = await sessionCookie();
    const tampered = cookie.replace('dl_session=v1.', 'dl_session=v2.');
    const response = await SELF.fetch(ASSET_URL, { headers: authHeaders(tampered) });
    expect(response.status).toBe(401);
  });

  it('rejects a non-allowlisted repository', async () => {
    const response = await SELF.fetch(`${ORIGIN}/dl/evil-org/evil-repo/file.zip`, {
      headers: authHeaders(await sessionCookie()),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'repo_not_allowed' });
    expect(upstreamCalls()).toHaveLength(0);
  });

  it.each([
    ['%2e%2e', 'encoded dot-dot'],
    ['%252e%252e', 'double encoded dot-dot'],
    ['..%2f..%2fetc%2fpasswd', 'encoded traversal'],
    ['file%2Fzip', 'encoded slash'],
    ['file%5czip', 'encoded backslash'],
    ['file%00zip', 'null byte'],
    ['%e4%b8%ad.zip', 'non-ascii'],
    [`${'a'.repeat(201)}.zip`, 'oversized segment'],
  ])('rejects malformed segment %s (%s)', async (segment) => {
    const response = await SELF.fetch(`${ORIGIN}/dl/${REPO}/${segment}`, {
      headers: authHeaders(await sessionCookie()),
    });
    expect([400, 404]).toContain(response.status);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it.each([
    [`/dl/${REPO}/${ASSET}/extra`, 'extra segment'],
    [`/dl/${REPO}/`, 'trailing slash'],
    [`/dl//${REPO}/${ASSET}`, 'duplicate slash'],
    [`/DL/${REPO}/${ASSET}`, 'wrong prefix case'],
    [`/dl/${REPO}/${ASSET}%2f..`, 'trailing encoded traversal'],
  ])('rejects malformed path %s (%s)', async (path) => {
    const response = await SELF.fetch(`${ORIGIN}${path}`, {
      headers: authHeaders(await sessionCookie()),
    });
    expect([400, 404]).toContain(response.status);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('rejects POST on the download route', async () => {
    const response = await SELF.fetch(ASSET_URL, {
      method: 'POST',
      headers: authHeaders(await sessionCookie()),
    });
    expect(response.status).toBe(405);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('does not expose anything on unknown routes', async () => {
    const response = await SELF.fetch(`${ORIGIN}/wp-admin/secret`, {
      headers: authHeaders(await sessionCookie()),
    });
    expect(response.status).toBe(404);
    expect(upstreamCalls()).toHaveLength(0);
  });
});

describe('metadata api', () => {
  it('requires a session', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/releases`);
    expect(response.status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('returns allowlisted releases with download paths', async () => {
    registerRelease();
    route('api.github.com', `/repos/${OTHER_REPO}/releases/latest`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `https://api.github.com/repos/${OTHER_REPO}/releases/7`,
        html_url: `https://github.com/${OTHER_REPO}/releases/tag/v2.0.0`,
        tag_name: 'v2.0.0',
        name: 'other',
        published_at: '2026-10-01T00:00:00Z',
        assets: [
          {
            name: 'other.zip',
            size: 5,
            download_count: 1,
            browser_download_url: `https://github.com/${OTHER_REPO}/releases/download/v2.0.0/other.zip`,
          },
        ],
      }),
    });

    const response = await SELF.fetch(`${ORIGIN}/api/releases`, {
      headers: authHeaders(await sessionCookie()),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      releases: Array<{ repo: string; assets: Array<{ path: string }> }>;
    };
    expect(body.releases).toHaveLength(2);
    expect(body.releases[0]?.repo).toBe(REPO);
    expect(body.releases[0]?.assets[0]?.path).toBe(`/dl/${REPO}/${encodeURIComponent(ASSET)}`);
    expect(body.releases[1]?.repo).toBe(OTHER_REPO);
  });
});

describe('home page', () => {
  it('serves the gate without a session', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('cf-turnstile');
    expect(html).not.toContain(REPO);
  });

  it('renders the release list with a session', async () => {
    registerRelease();
    route('api.github.com', `/repos/${OTHER_REPO}/releases/latest`, { status: 500, body: '' });

    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: authHeaders(await sessionCookie(), { accept: 'text/html' }),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(REPO);
    expect(html).toContain(ASSET);
    expect(html).toContain(`/dl/${REPO}/${ASSET}`);
    expect(html).toContain('GitHub API 暂时不可用');
    expect(html).toContain('upstream_error');
  });

  it('explains GitHub rate limiting and asks for a token', async () => {
    route('api.github.com', `/repos/${REPO}/releases/latest`, { status: 403, body: '' });
    route('api.github.com', `/repos/${OTHER_REPO}/releases/latest`, { status: 403, body: '' });

    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: authHeaders(await sessionCookie(), { accept: 'text/html' }),
    });

    const html = await response.text();
    expect(html).toContain('GitHub API 触发限流');
    expect(html).toContain('GITHUB_TOKEN');
    expect(html).toContain('rate_limited');
  });

  it('answers HEAD without a body', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`, {
      method: 'HEAD',
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('clears the session on logout', async () => {
    const response = await SELF.fetch(`${ORIGIN}/logout`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
