import { describe, expect, it } from 'vitest';

import { signSession, verifySession } from '../src/lib/auth';
import {
  contentDisposition,
  isAllowedAssetUrl,
  isSameHostOrigin,
  isSafeName,
  matchRepo,
  parseRepoList,
  pathSegments,
  resolveAllowedRedirect,
  safeNextPath,
  sanitizeRange,
} from '../src/lib/security';

const ORIGIN = 'https://dl.example.com';
const BASE = new URL('https://github.com/owner/repo/releases/download/v1/a.zip');

describe('pathSegments', () => {
  it('accepts plain paths', () => {
    expect(pathSegments('/dl/owner/repo/a.zip')).toEqual(['dl', 'owner', 'repo', 'a.zip']);
    expect(pathSegments('/dl/owner/repo/a+b.zip')).toEqual(['dl', 'owner', 'repo', 'a+b.zip']);
  });

  it.each([
    '/dl//repo/a.zip',
    '/dl/owner/repo/',
    '',
    'dl/owner',
    '/dl/owner/repo/a/b/c/d/e/f',
  ])('rejects structural garbage %s', (value) => {
    expect(pathSegments(value)).toBeNull();
  });

  it.each([
    '/dl/owner/repo/..',
    '/dl/owner/repo/.',
    '/dl/owner/repo/%2e%2e',
    '/dl/owner/repo/%2E%2E',
    '/dl/owner/repo/%252e%252e',
    '/dl/owner/repo/../../etc/passwd',
    '/dl/owner/repo/%2f',
    '/dl/owner/repo/file%2Fzip',
    '/dl/owner/repo/file%5czip',
    '/dl/owner/repo/file%00zip',
    '/dl/owner/repo/%ff',
    '/dl/owner/repo/%',
    '/dl/owner/repo/a b.zip',
  ])('rejects traversal attempt %s', (value) => {
    expect(pathSegments(value)).toBeNull();
  });
});

describe('isSafeName', () => {
  it('matches GitHub asset naming', () => {
    expect(isSafeName('app-1.0.0.zip')).toBe(true);
    expect(isSafeName('a_b+c.tar.gz')).toBe(true);
    expect(isSafeName('.hidden')).toBe(true);
    expect(isSafeName('..')).toBe(false);
    expect(isSafeName('.')).toBe(false);
    expect(isSafeName('a b.zip')).toBe(false);
    expect(isSafeName('a/b.zip')).toBe(false);
  });
});

describe('repo allowlist', () => {
  it('parses, dedupes and matches case-insensitively', () => {
    expect(parseRepoList('owner/repo, owner/repo, bad, other/repo')).toEqual([
      'owner/repo',
      'other/repo',
    ]);
    expect(matchRepo(['owner/repo'], 'Owner', 'Repo')).toBe('owner/repo');
    expect(matchRepo(['owner/repo'], 'owner', 'another')).toBeNull();
    expect(parseRepoList('owner/repo/../../etc')).toEqual([]);
    expect(parseRepoList('owner/..')).toEqual([]);
  });
});

describe('redirect allowlist', () => {
  it('accepts GitHub owned hosts', () => {
    expect(resolveAllowedRedirect('https://github.com/owner/repo', BASE)).not.toBeNull();
    expect(resolveAllowedRedirect('https://objects.githubusercontent.com/a', BASE)).not.toBeNull();
    expect(
      resolveAllowedRedirect('https://release-assets.githubusercontent.com/a?b=c', BASE),
    ).not.toBeNull();
    expect(resolveAllowedRedirect('/owner/repo', BASE)).not.toBeNull();
  });

  it.each([
    'https://evil.example/a',
    'http://github.com/a',
    'https://evil-githubusercontent.com/a',
    'https://x.objects.githubusercontent.com/a',
    'https://github.com.evil.example/a',
    'https://github.com:8443/a',
    'https://user:pass@github.com/a',
    'javascript:alert(1)',
    'data:text/plain,hi',
    '',
  ])('rejects %s', (location) => {
    expect(resolveAllowedRedirect(location, BASE)).toBeNull();
  });
});

describe('isAllowedAssetUrl', () => {
  it('requires the canonical release download path', () => {
    expect(
      isAllowedAssetUrl('https://github.com/owner/repo/releases/download/v1/a.zip', 'owner/repo'),
    ).not.toBeNull();
    expect(
      isAllowedAssetUrl('https://github.com/OWNER/REPO/releases/download/v1/a.zip', 'owner/repo'),
    ).not.toBeNull();
  });

  it.each([
    ['https://github.com/other/repo/releases/download/v1/a.zip', 'owner/repo'],
    ['https://github.com/owner/repo/releases/latest', 'owner/repo'],
    ['https://github.com/owner/repo/archive/refs/heads/main.zip', 'owner/repo'],
    ['https://github.com/owner/repo/releases/download/v1/a.zip?x=1', 'owner/repo'],
    ['https://raw.githubusercontent.com/owner/repo/main/a.zip', 'owner/repo'],
    ['https://objects.githubusercontent.com/owner/repo/releases/download/v1/a.zip', 'owner/repo'],
    ['not a url', 'owner/repo'],
  ])('rejects %s', (value, fullName) => {
    expect(isAllowedAssetUrl(value, fullName)).toBeNull();
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/dl/owner/repo/a.zip', '/dl/owner/repo/a.zip'],
    ['/dl/a.zip?x=1&y=2', '/dl/a.zip?x=1&y=2'],
    ['/', '/'],
    ['', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['http://dl.example.com/x', '/'],
    ['javascript:alert(1)', '/'],
    ['dl/x', '/'],
    ['/dl/x\nInjected: 1', '/'],
  ])('maps %s to %s', (input, expected) => {
    expect(safeNextPath(input, ORIGIN)).toBe(expected);
  });
});

describe('sanitizeRange', () => {
  it('keeps single ranges only', () => {
    expect(sanitizeRange('bytes=0-99')).toBe('bytes=0-99');
    expect(sanitizeRange('bytes=100-')).toBe('bytes=100-');
    expect(sanitizeRange('bytes=-100')).toBe('bytes=-100');
    expect(sanitizeRange('bytes=0-1,3-4')).toBeNull();
    expect(sanitizeRange('items=0-1')).toBeNull();
    expect(sanitizeRange('bytes=9-1')).toBeNull();
    expect(sanitizeRange('bytes=')).toBeNull();
    expect(sanitizeRange(null)).toBeNull();
  });
});

describe('contentDisposition', () => {
  it('cannot inject headers', () => {
    const value = contentDisposition('a"b\\c.zip');
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    expect(value).toContain('filename="a_b_c.zip"');
  });
});

describe('isSameHostOrigin', () => {
  it('allows missing or null origins', () => {
    expect(isSameHostOrigin(null, 'https://dl.example.com/admin')).toBe(true);
    expect(isSameHostOrigin('null', 'https://dl.example.com/admin')).toBe(true);
  });

  it('allows scheme differences on the same host', () => {
    expect(isSameHostOrigin('http://dl.example.com', 'https://dl.example.com/admin')).toBe(true);
    expect(isSameHostOrigin('https://dl.example.com', 'https://dl.example.com/admin')).toBe(true);
  });

  it('rejects another host or garbage', () => {
    expect(isSameHostOrigin('https://evil.example', 'https://dl.example.com/admin')).toBe(false);
    expect(isSameHostOrigin('not a url', 'https://dl.example.com/admin')).toBe(false);
  });
});

describe('session tokens', () => {
  const secret = 'unit-test-secret-0123456789abcdef0123456789';

  async function rawSign(payload: string, keySecret = secret): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(keySecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    );
    let binary = '';
    for (const byte of signature) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${payload}.${encoded}`;
  }

  it('round-trips', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession(
      { iat: now, exp: now + 600, jti: 'b'.repeat(16), sub: 'deadbeef' },
      secret,
    );
    const parsed = await verifySession(token, secret);
    expect(parsed?.jti).toBe('b'.repeat(16));
    expect(parsed?.sub).toBe('deadbeef');
  });

  it('rejects a token signed with another key', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession(
      { iat: now, exp: now + 600, jti: 'b'.repeat(16), sub: '' },
      secret,
    );
    expect(await verifySession(token, 'different-secret-0123456789abcdef0123456789')).toBeNull();
  });

  it('rejects a validly signed token with an absurd ttl', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = ['v1', now, now + 30 * 24 * 3600, 'c'.repeat(16), ''].join('.');
    const token = await rawSign(payload);
    expect(await verifySession(token, secret)).toBeNull();
  });

  it('rejects an iat far in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = ['v1', now + 600, now + 1200, 'c'.repeat(16), ''].join('.');
    expect(await verifySession(await rawSign(payload), secret)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = ['v1', now - 1000, now - 10, 'c'.repeat(16), ''].join('.');
    expect(await verifySession(await rawSign(payload), secret)).toBeNull();
  });

  it('rejects malformed payloads', async () => {
    expect(await verifySession('', secret)).toBeNull();
    expect(await verifySession('v1.1.2.3.4', secret)).toBeNull();
    expect(await verifySession('v2.1.2.abcdefgh.00.x', secret)).toBeNull();
  });
});
