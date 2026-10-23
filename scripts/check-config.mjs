#!/usr/bin/env node
/**
 * Refuses to deploy while wrangler.jsonc still contains template values.
 * Replacing a placeholder with a real value is always intentional, so a
 * missing/placeholder config should fail loudly instead of half-deploying.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'wrangler.jsonc');

if (!existsSync(configPath)) {
  console.error('[check-config] wrangler.jsonc is missing. Run: npm run bootstrap');
  process.exit(1);
}

const config = readFileSync(configPath, 'utf8');
const placeholders = [
  ['00000000000000000000000000000000', 'KV namespace id (wrangler kv namespace create RATE_LIMIT)'],
  ['YOUR_TURNSTILE_SITE_KEY', 'Turnstile Site Key (dash.cloudflare.com -> Turnstile)'],
  ['dl.example.com', 'custom domain in routes[0].pattern'],
  ['owner/repo', 'repository whitelist in vars.REPOS'],
];

const hits = placeholders.filter(([needle]) => config.includes(needle));
if (hits.length > 0) {
  console.error('[check-config] wrangler.jsonc still contains placeholders:');
  for (const [needle, hint] of hits) console.error(`  - ${needle}  ->  ${hint}`);
  process.exit(1);
}

console.log('[check-config] wrangler.jsonc looks configured');
