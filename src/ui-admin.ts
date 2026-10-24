/** Server-rendered admin pages. No client-side JavaScript. */

import type { MetricsSummary } from './metrics-do';
import { esc, formatBytes } from './ui';

const ADMIN_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface RangeOption {
  key: '24h' | '7d' | '30d';
  days: number;
}

export const RANGES: RangeOption[] = [
  { key: '24h', days: 1 },
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
];

function adminHtml(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': ADMIN_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body class="admin">
${body}
</body>
</html>`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTime(ms: number): string {
  if (!ms) return '暂无数据';
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

export function renderAdminLogin(message?: string, status = message ? 401 : 200): Response {
  const body = `  <main class="card">
    <h1>管理登录</h1>
    <p>输入 <code>ADMIN_TOKEN</code> 查看下载统计。</p>
    <form method="post" action="/admin/login" class="login-form">
      <input class="field" type="password" name="token" required autofocus
             autocomplete="current-password" placeholder="ADMIN_TOKEN">
      <button class="btn" type="submit">登录</button>
    </form>
    ${message ? `<p class="msg err">${esc(message)}</p>` : ''}
  </main>`;

  return adminHtml(shell('管理登录', body), status);
}

export function renderAdminPage(summary: MetricsSummary, range: RangeOption): Response {
  const tabs = RANGES.map(
    (option) =>
      `<a class="tab${option.key === range.key ? ' active' : ''}" href="/admin?range=${option.key}">${option.key}</a>`,
  ).join('');

  const cards = `
    <div class="metric"><div class="value">${summary.requests}</div><div class="label">下载请求</div></div>
    <div class="metric"><div class="value">${summary.cacheable}</div><div class="label">可缓存（完整 200）</div></div>
    <div class="metric"><div class="value">${esc(formatBytes(summary.bytes))}</div><div class="label">流量</div></div>
    <div class="metric"><div class="value">${summary.assets.length}</div><div class="label">资产 / ${summary.colos.length} 个 colo</div></div>
    <div class="metric"><div class="value">${esc(seconds(summary.ttfb.p50))}</div><div class="label">回源 TTFB p50 / p95 ${esc(seconds(summary.ttfb.p95))}</div></div>
    <div class="metric"><div class="value">${esc(seconds(summary.handler.p50))}</div><div class="label">处理耗时 p50 / p95 ${esc(seconds(summary.handler.p95))}</div></div>`;

  const ttlRows = summary.ttls
    .map(
      (ttl) => `<tr>
        <td>${esc(rangeLabel(ttl.ttlMs))}</td>
        <td class="num">${ttl.hits}</td>
        <td class="num">${ttl.misses}</td>
        <td class="num">${percent(ttl.hitRate)}</td>
        <td class="num">${percent(ttl.originShare)}</td>
        <td class="num">${esc(formatBytes(ttl.bytesSaved))}</td>
      </tr>`,
    )
    .join('');

  const assetRows =
    summary.assets.length === 0
      ? '<tr><td colspan="8" class="empty">该时间范围内没有下载。</td></tr>'
      : summary.assets
          .map(
            (asset) => `<tr>
        <td class="mono">${esc(asset.repo)}</td>
        <td class="mono">${esc(asset.asset)}</td>
        <td class="num">${asset.requests}</td>
        <td class="num">${esc(formatBytes(asset.bytes))}</td>
        <td>${esc(asset.colos.join(', '))}</td>
        <td class="num">${percent(asset.ttls[0]?.hitRate ?? 0)}</td>
        <td class="num">${percent(asset.ttls[1]?.hitRate ?? 0)}</td>
        <td class="num">${percent(asset.ttls[2]?.hitRate ?? 0)}</td>
      </tr>`,
          )
          .join('');

  const coloRows =
    summary.colos.length === 0
      ? '<tr><td colspan="4" class="empty">暂无数据。</td></tr>'
      : summary.colos
          .map(
            (colo) => `<tr>
        <td class="mono">${esc(colo.colo)}</td>
        <td>${esc(colo.country)}</td>
        <td class="num">${colo.requests}</td>
        <td class="num">${esc(formatBytes(colo.bytes))}</td>
      </tr>`,
          )
          .join('');

  const body = `  <main class="stats">
    <header class="stats-head">
      <div>
        <h1>下载统计</h1>
        <p class="meta">最近 ${summary.days} 天 · ${esc(formatTime(summary.firstTs))} ~ ${esc(formatTime(summary.lastTs))}</p>
      </div>
      <div class="stats-actions">
        <a class="button" href="/admin/export.csv?range=${range.key}">导出 CSV</a>
        <a class="button" href="/admin/logout">退出</a>
      </div>
    </header>

    <nav class="tabs">${tabs}</nav>

    <div class="cards">${cards}</div>

    <h2 class="section-title">缓存模拟（按 colo + 仓库 + 资产回放）</h2>
    <table class="data">
      <thead><tr><th>TTL</th><th class="num">命中</th><th class="num">未命中</th><th class="num">命中率</th><th class="num">回源占比</th><th class="num">可省字节</th></tr></thead>
      <tbody>${ttlRows}</tbody>
    </table>

    <h2 class="section-title">按资产</h2>
    <table class="data">
      <thead><tr><th>仓库</th><th>资产</th><th class="num">请求</th><th class="num">字节</th><th>Colo</th><th class="num">1h</th><th class="num">6h</th><th class="num">24h</th></tr></thead>
      <tbody>${assetRows}</tbody>
    </table>

    <h2 class="section-title">按 Colo</h2>
    <table class="data">
      <thead><tr><th>Colo</th><th>国家</th><th class="num">请求</th><th class="num">字节</th></tr></thead>
      <tbody>${coloRows}</tbody>
    </table>

    <p class="hint">
      样本 ${summary.requests} 条${summary.truncated ? '（超过 5 万行，已截断）' : ''}。
      命中率低于 30% 或回源 TTFB 低于 300ms 时，不建议引入缓存。
    </p>
  </main>`;

  return adminHtml(shell('下载统计', body));
}

function rangeLabel(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export function renderAdminUnavailable(): Response {
  const body = `  <main class="card">
    <h1>统计不可用</h1>
    <p>METRICS 绑定未配置或暂时不可用。</p>
  </main>`;
  return adminHtml(shell('统计不可用', body), 503);
}
