#!/usr/bin/env node
/**
 * Analyses `wrangler tail --format json` output and answers:
 * "would an edge cache have helped, and how much?"
 *
 * Usage:
 *   npx wrangler tail --format json > tail.ndjson      # collect, then Ctrl+C
 *   node scripts/analyze-logs.mjs tail.ndjson
 *   node scripts/analyze-logs.mjs tail.ndjson --ttl 3600,21600,86400
 *   node scripts/analyze-logs.mjs tail.ndjson --json
 */

import { readFileSync } from 'node:fs';

import { parseTailLines, summarize } from './lib/analyze.mjs';

const DEFAULT_TTLS = '3600,21600,86400';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTtl(ms) {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function formatTime(ms) {
  if (!ms) return 'n/a';
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function parseArgs(argv) {
  const args = { file: '', ttl: DEFAULT_TTLS, json: false, min: 50 };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--ttl') {
      args.ttl = argv[i + 1] ?? DEFAULT_TTLS;
      i += 1;
    } else if (arg === '--min') {
      args.min = Number.parseInt(argv[i + 1] ?? '50', 10) || 0;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!arg.startsWith('-')) {
      rest.push(arg);
    }
  }

  args.file = rest[0] ?? '';
  return args;
}

function parseTtls(raw) {
  const ttls = [];
  for (const part of raw.split(',')) {
    const value = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(value) && value > 0) ttls.push(value * 1000);
  }
  return ttls.length > 0 ? ttls : DEFAULT_TTLS.split(',').map((v) => Number(v) * 1000);
}

function usage() {
  console.log(`Usage: node scripts/analyze-logs.mjs <tail.ndjson|-> [options]

Options:
  --ttl <seconds,...>   Cache TTLs to simulate (default: ${DEFAULT_TTLS})
  --min <n>             Warn when fewer than n successful downloads (default: 50)
  --json                Print machine-readable JSON
  -h, --help            Show this help

Collect logs first:
  npx wrangler tail --format json > tail.ndjson   (Ctrl+C to stop)`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.file) {
    usage();
    process.exitCode = 2;
    return;
  }

  let text;
  try {
    text = args.file === '-' ? readFileSync(0, 'utf8') : readFileSync(args.file, 'utf8');
  } catch (error) {
    console.error(`[analyze] cannot read ${args.file}: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const ttls = parseTtls(args.ttl);
  const events = parseTailLines(text);
  const summary = summarize(events, ttls);

  if (args.json) {
    console.log(JSON.stringify({ file: args.file, summary }, null, 2));
    return;
  }

  console.log(`文件: ${args.file}`);
  console.log(`下载事件: ${summary.totalEvents} 条（成功且非 Range: ${summary.successful} 条）`);
  console.log(`时间范围: ${formatTime(summary.firstEventAt)} ~ ${formatTime(summary.lastEventAt)}`);

  if (summary.totalEvents === 0) {
    console.error('[analyze] 没有找到下载事件。确认日志里有 {"evt":"dl",...} 行。');
    process.exitCode = 1;
    return;
  }

  if (summary.colos.length > 0) {
    console.log(`Colo 分布: ${summary.colos.map((c) => `${c.colo}=${c.requests}`).join('  ')}`);
  }

  console.log(
    `回源 TTFB: p50=${formatSeconds(summary.ttfb.p50)}  p95=${formatSeconds(summary.ttfb.p95)}`,
  );
  console.log(
    `处理耗时:  p50=${formatSeconds(summary.handler.p50)}  p95=${formatSeconds(summary.handler.p95)}`,
  );
  console.log(`字节总量: ${formatBytes(summary.bytes)}`);

  console.log('\n按 TTL 模拟（同一 colo + 同一仓库 + 同一资产的重复请求视为可命中）:');
  console.log('  TTL      命中    未命中   命中率    回源占比   可省字节');
  for (const ttl of summary.ttls) {
    console.log(
      `  ${formatTtl(ttl.ttlMs).padEnd(7)}  ${String(ttl.hits).padEnd(6)}  ${String(
        ttl.misses,
      ).padEnd(7)}  ${formatPercent(ttl.hitRate).padEnd(8)}  ${formatPercent(
        ttl.originShare,
      ).padEnd(8)}  ${formatBytes(ttl.bytesSaved)}`,
    );
  }

  if (summary.assets.length > 0) {
    console.log('\n按仓库/资产:');
    for (const asset of summary.assets.slice(0, 10)) {
      console.log(
        `  ${asset.repo}/${asset.asset}  requests=${asset.requests}  bytes=${formatBytes(asset.bytes)}  colos=${asset.colos.join(',')}`,
      );
    }
  }

  if (summary.successful < args.min) {
    console.log(
      `\n[提示] 成功下载只有 ${summary.successful} 条（少于 ${args.min}），结论仅供参考；建议继续采集。`,
    );
  }
}

main();
