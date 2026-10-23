import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ORIGIN, TEST_ADMIN_TOKEN, adminCookie, sessionCookie } from './helpers';

const LOGIN_URL = `${ORIGIN}/admin/login`;

function loginBody(token: string): string {
  return new URLSearchParams({ token }).toString();
}

function formHeaders(origin = ORIGIN): Record<string, string> {
  return { 'content-type': 'application/x-www-form-urlencoded', origin };
}

describe('admin gate', () => {
  it('redirects anonymous visitors to the login page', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/login');
  });

  it('serves a password form', async () => {
    const response = await SELF.fetch(LOGIN_URL);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="token"');
    expect(html).toContain('type="password"');
  });

  it('rejects a wrong token without setting a cookie', async () => {
    const response = await SELF.fetch(LOGIN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: formHeaders(),
      body: loginBody('definitely-not-the-token'),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('accepts the configured token and sets a strict cookie', async () => {
    const response = await SELF.fetch(LOGIN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: formHeaders(),
      body: loginBody(TEST_ADMIN_TOKEN),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('dl_admin=');
    expect(cookie).toContain('Path=/admin');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('rejects cross-origin login posts', async () => {
    const response = await SELF.fetch(LOGIN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: formHeaders('https://evil.example'),
      body: loginBody(TEST_ADMIN_TOKEN),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('cannot be reached with a download session token', async () => {
    const token = (await sessionCookie()).slice('dl_session='.length);
    const response = await SELF.fetch(`${ORIGIN}/admin`, {
      redirect: 'manual',
      headers: { cookie: `dl_admin=${token}` },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/login');
  });

  it('serves the dashboard with a valid admin cookie', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin`, {
      headers: { cookie: await adminCookie(), accept: 'text/html' },
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('下载统计');
    expect(html).toContain('缓存模拟');
    expect(html).toContain('导出 CSV');
  });

  it('exports CSV', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin/export.csv?range=7d`, {
      headers: { cookie: await adminCookie() },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(await response.text()).toContain('asset,tag,requests');
  });

  it('clears the cookie on logout', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin/logout`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('does not reveal unknown admin paths without a session', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin/nope`, { redirect: 'manual' });
    expect(response.status).toBe(302);
  });
});
