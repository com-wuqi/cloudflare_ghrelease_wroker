#!/usr/bin/env node
/**
 * Refuses to deploy while wrangler.jsonc is missing or still contains template
 * values. Checks are structural (route, repos, KV id, DO binding/migration)
 * instead of substring matching, so a half-configured file fails loudly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig, validateConfig } from './lib/config-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'wrangler.jsonc');

if (!existsSync(configPath)) {
  console.error('[check-config] wrangler.jsonc is missing. Run: npm run bootstrap');
  process.exit(1);
}

let config;
try {
  config = parseConfig(readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error('[check-config] wrangler.jsonc is not valid JSONC:', error.message);
  process.exit(1);
}

const errors = validateConfig(config);
if (errors.length > 0) {
  console.error('[check-config] wrangler.jsonc is not ready to deploy:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('[check-config] wrangler.jsonc looks configured');
