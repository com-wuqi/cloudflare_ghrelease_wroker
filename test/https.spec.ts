import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ORIGIN, REPO } from './helpers';

describe('https upgrade', () => {
  it('redirects plain HTTP and preserves the path and query', async () => {
    const response = await SELF.fetch(
      `http://dl.example.com/dl/${REPO}/app-1.0.0.zip?download=1`,
      { redirect: 'manual', headers: { 'x-forwarded-proto': 'http' } },
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      `https://dl.example.com/dl/${REPO}/app-1.0.0.zip?download=1`,
    );
  });

  it('does not redirect when no edge headers are present (wrangler dev / tests)', async () => {
    const response = await SELF.fetch('http://dl.example.com/', { redirect: 'manual' });

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('upgrades when CF-Visitor reports http', async () => {
    const response = await SELF.fetch('http://dl.example.com/healthz', {
      redirect: 'manual',
      headers: { 'cf-visitor': '{"scheme":"http"}' },
    });

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://dl.example.com/healthz');
  });

  it('keeps the method on redirects so a POST is not turned into a GET', async () => {
    const response = await SELF.fetch('http://dl.example.com/api/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http' },
      body: JSON.stringify({ token: 'x'.repeat(20) }),
    });

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://dl.example.com/api/verify');
  });

  it('does not redirect local development hosts', async () => {
    const response = await SELF.fetch('http://127.0.0.1:8787/healthz', {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'http' },
    });

    expect(response.status).toBe(200);
  });

  it('leaves HTTPS alone and sends HSTS', async () => {
    const response = await SELF.fetch(`${ORIGIN}/healthz`, {
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('does not send HSTS on a plain HTTP redirect', async () => {
    const response = await SELF.fetch('http://dl.example.com/', {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'http' },
    });

    expect(response.headers.get('strict-transport-security')).toBeNull();
  });
});
