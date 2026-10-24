/**
 * Dependency-free validation for wrangler.jsonc.
 *
 * Wrangler accepts JSONC (comments and trailing commas), so a plain
 * `JSON.parse` is not enough. The helpers below are pure so they can be tested
 * without touching the filesystem.
 */

/** Remove `//` and block comments without touching string contents. */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      out += ' ';
      continue;
    }

    out += char;
  }

  return out;
}

/** Remove commas directly before `}` or `]`, ignoring strings. */
export function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }

    out += char;
  }

  return out;
}

/** Parse a JSONC document (comments + trailing commas). */
export function parseConfig(text) {
  const clean = text.replace(/^\uFEFF/, '');
  return JSON.parse(stripTrailingCommas(stripJsonComments(clean)));
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const HOST_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const KV_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Return human-readable errors for a parsed wrangler config. An empty array
 * means the deployment-critical fields look usable.
 *
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
export function validateConfig(config) {
  /** @type {string[]} */
  const errors = [];
  const vars = config?.vars ?? {};

  const repos =
    typeof vars.REPOS === 'string'
      ? vars.REPOS.split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : [];
  if (repos.length === 0) {
    errors.push('vars.REPOS: at least one owner/repo is required');
  } else {
    if (repos.length > 20) errors.push('vars.REPOS: at most 20 repositories are supported');
    for (const repo of repos) {
      if (!REPO_RE.test(repo)) errors.push(`vars.REPOS: invalid entry "${repo}"`);
    }
    if (repos.includes('owner/repo')) errors.push('vars.REPOS: replace the example repository');
  }

  const siteKey = typeof vars.TURNSTILE_SITE_KEY === 'string' ? vars.TURNSTILE_SITE_KEY.trim() : '';
  if (!siteKey || siteKey.startsWith('YOUR_')) {
    errors.push('vars.TURNSTILE_SITE_KEY: replace the placeholder');
  }

  const route = config?.routes?.[0]?.pattern;
  const routeHost = typeof route === 'string' ? route.replace(/\/.*$/, '') : route;
  if (typeof routeHost !== 'string' || !HOST_RE.test(routeHost)) {
    errors.push('routes[0].pattern: expected a hostname such as dl.example.com');
  } else if (routeHost.toLowerCase() === 'dl.example.com') {
    errors.push('routes[0].pattern: replace the example domain');
  }

  const kvId = config?.kv_namespaces?.[0]?.id;
  if (typeof kvId !== 'string' || !KV_ID_RE.test(kvId) || /^0+$/.test(kvId)) {
    errors.push('kv_namespaces[0].id: replace the 32-hex placeholder');
  }

  const bindings = config?.durable_objects?.bindings;
  const hasMetricsBinding =
    Array.isArray(bindings) &&
    bindings.some((binding) => binding?.name === 'METRICS' && binding?.class_name === 'MetricsDO');
  if (!hasMetricsBinding) {
    errors.push('durable_objects.bindings: METRICS -> MetricsDO is required');
  }

  const migrations = config?.migrations;
  const hasMetricsMigration =
    Array.isArray(migrations) &&
    migrations.some(
      (migration) =>
        Array.isArray(migration?.new_sqlite_classes) &&
        migration.new_sqlite_classes.includes('MetricsDO'),
    );
  if (!hasMetricsMigration) {
    errors.push('migrations: new_sqlite_classes must include MetricsDO');
  }

  return errors;
}
