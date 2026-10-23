#!/usr/bin/env node
/**
 * Creates the local-only config files from their templates.
 *
 * wrangler.jsonc and .dev.vars are gitignored on purpose: they hold account
 * identifiers and secrets. This script makes a fresh clone runnable without
 * ever committing them.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pairs = [
  ['wrangler.example.jsonc', 'wrangler.jsonc'],
  ['.dev.vars.example', '.dev.vars'],
];

let created = 0;
for (const [source, target] of pairs) {
  const destination = join(root, target);
  if (existsSync(destination)) continue;
  copyFileSync(join(root, source), destination);
  console.log(`[bootstrap] created ${target} from ${source}`);
  created += 1;
}

if (created === 0) {
  console.log('[bootstrap] wrangler.jsonc and .dev.vars already exist');
} else {
  console.log('[bootstrap] now edit wrangler.jsonc: domain, KV id, Turnstile site key, REPOS');
}
