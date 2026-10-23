/**
 * Path / URL validation helpers.
 *
 * Everything in this file is deliberately strict: input is never concatenated
 * into an upstream URL, it is decoded exactly once, validated against an
 * allowlist pattern and then re-encoded.
 */

const SEGMENT_RE = /^[A-Za-z0-9._+-]{1,200}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Hosts we are willing to follow a redirect to. */
const REDIRECT_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

/** `owner/repo` as accepted from configuration or the GitHub API. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** GitHub asset names are sanitised by GitHub itself; keep it at that charset. */
export function isSafeName(value: string): boolean {
  return SEGMENT_RE.test(value) && value !== '.' && value !== '..';
}

/**
 * Decode a single URL path segment exactly once and validate it.
 * Returns `null` for anything suspicious (traversal, double encoding,
 * separators, control characters, invalid escapes, empty input).
 */
export function decodeSegment(raw: string): string | null {
  if (raw.length === 0 || raw.length > 300) return null;
  if (CONTROL_RE.test(raw)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (CONTROL_RE.test(decoded)) return null;
  // A literal `%` left after one decode means the input was double encoded.
  if (decoded.includes('%')) return null;
  if (decoded === '.' || decoded === '..') return null;
  if (!SEGMENT_RE.test(decoded)) return null;
  return decoded;
}

/**
 * Split and validate a pathname. Empty segments (duplicate or trailing
 * slashes) are rejected, so `//`, `/dl//`, `/dl/x/` all fail.
 */
export function pathSegments(pathname: string): string[] | null {
  if (!pathname.startsWith('/')) return null;
  const raw = pathname.slice(1).split('/');
  if (raw.length === 0 || raw.length > 8) return null;

  const out: string[] = [];
  for (const part of raw) {
    if (part.length === 0) return null;
    const decoded = decodeSegment(part);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

export function normalizeRepo(value: string): string | null {
  const trimmed = value.trim();
  if (!REPO_RE.test(trimmed)) return null;
  if (trimmed.includes('..')) return null;
  return trimmed;
}

export function parseRepoList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const repo = normalizeRepo(part);
    if (!repo) continue;
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
    if (out.length >= 20) break;
  }
  return out;
}

/** Returns the configured spelling of the repo when it is allowlisted. */
export function matchRepo(list: readonly string[], owner: string, repo: string): string | null {
  const wanted = `${owner}/${repo}`.toLowerCase();
  for (const item of list) {
    if (item.toLowerCase() === wanted) return item;
  }
  return null;
}

export function isAllowedRedirectUrl(target: URL): boolean {
  if (target.protocol !== 'https:') return false;
  if (target.username !== '' || target.password !== '') return false;
  if (target.port !== '' && target.port !== '443') return false;

  const host = target.hostname.toLowerCase();
  if (REDIRECT_HOSTS.has(host)) return true;
  // Exactly one label in front of the registrable GitHub asset domain.
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.githubusercontent\.com$/.test(host);
}

/**
 * Resolve a `Location` header against the current upstream URL and only accept
 * it when it stays on an allowlisted GitHub-owned host.
 */
export function resolveAllowedRedirect(location: string | null, base: URL): URL | null {
  if (!location || location.length > 4096) return null;
  if (CONTROL_RE.test(location)) return null;

  let target: URL;
  try {
    target = new URL(location, base);
  } catch {
    return null;
  }
  return isAllowedRedirectUrl(target) ? target : null;
}

/**
 * Validate an asset download URL coming from the GitHub API. It must be the
 * canonical `https://github.com/<owner>/<repo>/releases/download/...` shape.
 */
export function isAllowedAssetUrl(value: string, fullName: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!isAllowedRedirectUrl(url)) return null;
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  if (url.search !== '' || url.hash !== '') return null;

  const prefix = `/${fullName.toLowerCase()}/releases/download/`;
  if (!url.pathname.toLowerCase().startsWith(prefix)) return null;
  return url;
}

/**
 * Sanitise a post-verification redirect target. Only same-origin, absolute
 * paths are accepted; everything else falls back to `/`.
 */
export function safeNextPath(value: string | null | undefined, origin: string): string {
  if (!value || value.length > 1024) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (CONTROL_RE.test(value)) return '/';

  let target: URL;
  try {
    target = new URL(value, origin);
  } catch {
    return '/';
  }
  if (target.origin !== origin) return '/';
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return '/';
  return `${target.pathname}${target.search}`;
}

/** Single-range `bytes=` header only, everything else is dropped. */
export function sanitizeRange(value: string | null): string | null {
  if (!value || value.length > 100) return null;
  const match = /^bytes=(\d{0,18})-(\d{0,18})$/.exec(value.trim());
  if (!match) return null;

  const start = match[1] ?? '';
  const end = match[2] ?? '';
  if (start === '' && end === '') return null;
  if (start !== '' && end !== '' && Number(end) < Number(start)) return null;
  return `bytes=${start}-${end}`;
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
