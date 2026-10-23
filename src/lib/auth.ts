/**
 * Session cookies: `v1.<iat>.<exp>.<jti>.<sub>.<hmac>` signed with
 * HMAC-SHA256. No JWT library, no server-side session store.
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE = 'dl_session';
const MAX_TTL_SECONDS = 7200;
const MIN_SECRET_LENGTH = 32;

export interface Session {
  iat: number;
  exp: number;
  jti: string;
  sub: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  if (remainder === 1) return null;
  const withPadding = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
  try {
    const binary = atob(withPadding);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export function sessionSecretUsable(secret: string | undefined | null): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

export async function signSession(session: Session, secret: string): Promise<string> {
  if (!sessionSecretUsable(secret)) {
    throw new Error('SESSION_SECRET missing or shorter than 32 characters');
  }
  if (session.exp <= session.iat) throw new Error('invalid session window');
  if (session.exp - session.iat > MAX_TTL_SECONDS) throw new Error('session TTL too long');

  const payload = ['v1', String(session.iat), String(session.exp), session.jti, session.sub].join('.');
  const key = await importKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${base64UrlEncode(signature)}`;
}

export async function verifySession(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  if (!sessionSecretUsable(secret)) return null;
  if (token.length === 0 || token.length > 512) return null;

  const parts = token.split('.');
  if (parts.length !== 6) return null;

  const [version, iatRaw, expRaw, jti, sub, signatureRaw] = parts;
  if (!version || !iatRaw || !expRaw || !jti || sub === undefined || !signatureRaw) return null;
  if (version !== 'v1') return null;
  if (!/^\d{1,12}$/.test(iatRaw) || !/^\d{1,12}$/.test(expRaw)) return null;

  const iat = Number(iatRaw);
  const exp = Number(expRaw);
  if (exp <= nowSeconds) return null;
  if (iat > nowSeconds + 60) return null;
  if (exp - iat > MAX_TTL_SECONDS) return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(jti)) return null;
  if (!/^[a-f0-9]{0,64}$/.test(sub)) return null;

  const signature = base64UrlDecode(signatureRaw);
  if (!signature) return null;

  const payload = parts.slice(0, 5).join('.');
  const key = await importKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
  if (!valid) return null;

  return { iat, exp, jti, sub };
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header || header.length > 8192) return null;

  for (const piece of header.split(';')) {
    const separator = piece.indexOf('=');
    if (separator < 0) continue;
    if (piece.slice(0, separator).trim() !== name) continue;
    const value = piece.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function buildSessionCookie(token: string, ttlSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ].join('; ');
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function subjectFor(request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const userAgent = request.headers.get('user-agent') ?? '';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`sub\n${ip}\n${userAgent}`));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function randomId(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
