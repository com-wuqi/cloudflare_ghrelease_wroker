import { describe, expect, it } from 'vitest';

import {
  parseConfig,
  stripJsonComments,
  stripTrailingCommas,
  validateConfig,
} from '../scripts/lib/config-check.mjs';

const VALID = {
  vars: {
    REPOS: 'example/app,other-org/other-repo',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  },
  routes: [{ pattern: 'dl.mysite.dev' }],
  kv_namespaces: [{ id: '5b74bd82385d48e08451af00a08250de' }],
  durable_objects: { bindings: [{ name: 'METRICS', class_name: 'MetricsDO' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['MetricsDO'] }],
};

describe('JSONC parsing', () => {
  it('removes line and block comments but keeps strings intact', () => {
    const text = `{
      // line comment
      "url": "https://example.com/a//b",
      /* block
         comment */
      "value": "/* not a comment */"
    }`;

    expect(stripJsonComments(text)).toContain('"url": "https://example.com/a//b"');
    expect(stripJsonComments(text)).toContain('"value": "/* not a comment */"');
    expect(parseConfig(text)).toEqual({
      url: 'https://example.com/a//b',
      value: '/* not a comment */',
    });
  });

  it('removes trailing commas outside strings', () => {
    const text = '{"a": [1, 2,], "b": "x,}",}';
    expect(stripTrailingCommas(text)).toBe('{"a": [1, 2], "b": "x,}"}');
    expect(parseConfig(text)).toEqual({ a: [1, 2], b: 'x,}' });
  });

  it('parses the example wrangler config', () => {
    const config = parseConfig(`{
      // template
      "vars": { "REPOS": "owner/repo", },
    }`);
    expect(config).toEqual({ vars: { REPOS: 'owner/repo' } });
  });

  it('tolerates a UTF-8 BOM', () => {
    expect(parseConfig('\uFEFF{"a": 1}')).toEqual({ a: 1 });
  });
});

describe('validateConfig', () => {
  it('accepts a complete config', () => {
    expect(validateConfig(VALID)).toEqual([]);
  });

  it('rejects an empty config', () => {
    const errors = validateConfig({});
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it('validates REPOS entries and count', () => {
    expect(validateConfig({ ...VALID, vars: { ...VALID.vars, REPOS: '' } })).toContain(
      'vars.REPOS: at least one owner/repo is required',
    );
    expect(validateConfig({ ...VALID, vars: { ...VALID.vars, REPOS: 'owner/repo' } })).toContain(
      'vars.REPOS: replace the example repository',
    );
    expect(validateConfig({ ...VALID, vars: { ...VALID.vars, REPOS: 'bad repo' } })).toContain(
      'vars.REPOS: invalid entry "bad repo"',
    );

    const many = Array.from({ length: 21 }, (_, i) => `owner/repo-${i}`).join(',');
    expect(validateConfig({ ...VALID, vars: { ...VALID.vars, REPOS: many } })).toContain(
      'vars.REPOS: at most 20 repositories are supported',
    );
  });

  it('validates the Turnstile key', () => {
    expect(
      validateConfig({
        ...VALID,
        vars: { ...VALID.vars, TURNSTILE_SITE_KEY: 'YOUR_TURNSTILE_SITE_KEY' },
      }),
    ).toContain('vars.TURNSTILE_SITE_KEY: replace the placeholder');
  });

  it('validates the custom domain', () => {
    expect(validateConfig({ ...VALID, routes: [{ pattern: 'dl.mysite.dev/*' }] })).toEqual([]);
    expect(validateConfig({ ...VALID, routes: [{ pattern: 'dl.example.com' }] })).toContain(
      'routes[0].pattern: replace the example domain',
    );
    expect(
      validateConfig({ ...VALID, routes: [{ pattern: 'https://dl.mysite.dev/dl' }] }),
    ).toContain('routes[0].pattern: expected a hostname such as dl.example.com');
  });

  it('validates the KV namespace id', () => {
    expect(validateConfig({ ...VALID, kv_namespaces: [{ id: '0'.repeat(32) }] })).toContain(
      'kv_namespaces[0].id: replace the 32-hex placeholder',
    );
    expect(validateConfig({ ...VALID, kv_namespaces: [{ id: 'short' }] })).toContain(
      'kv_namespaces[0].id: replace the 32-hex placeholder',
    );
  });

  it('requires the metrics binding and migration', () => {
    expect(validateConfig({ ...VALID, durable_objects: { bindings: [] } })).toContain(
      'durable_objects.bindings: METRICS -> MetricsDO is required',
    );
    expect(validateConfig({ ...VALID, migrations: [] })).toContain(
      'migrations: new_sqlite_classes must include MetricsDO',
    );
  });
});
