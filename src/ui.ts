/** Server-rendered pages. Every interpolated value is HTML-escaped. */

import type { ReleaseFailure, ReleaseInfo } from './release';

export const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  'frame-src https://challenges.cloudflare.com',
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPE_MAP[character] ?? character);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
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

function formatDate(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function shell(title: string, bodyClass: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body class="${esc(bodyClass)}">
${body}
</body>
</html>`;
}

export interface GateOptions {
  siteKey: string;
  next: string;
}

export function renderGate(options: GateOptions): Response {
  if (!options.siteKey) return renderConfigError('TURNSTILE_SITE_KEY 未配置。');

  const body = `  <main class="card">
    <h1>人机验证</h1>
    <p>通过验证后即可下载最新 Release。</p>
    <div class="turnstile-slot">
      <div class="cf-turnstile"
           data-sitekey="${esc(options.siteKey)}"
           data-theme="auto"
           data-language="zh-cn"
           data-callback="onTurnstileOk"
           data-error-callback="onTurnstileError"
           data-expired-callback="onTurnstileExpired"></div>
    </div>
    <p id="msg" class="msg" role="status" aria-live="polite"></p>
    <noscript><p class="msg err">需要启用 JavaScript 才能完成验证。</p></noscript>
    <p class="hint">验证仅用于防止自动化滥用，不收集浏览记录。</p>
  </main>
  <input type="hidden" id="next" value="${esc(options.next)}">
  <script src="/assets/app.js" defer></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>`;

  return htmlResponse(shell('人机验证', 'gate', body));
}

export function renderConfigError(detail: string): Response {
  const body = `  <main class="card">
    <h1>服务未就绪</h1>
    <p>${esc(detail)}</p>
    <p class="hint">请联系站点管理员完成 Cloudflare 配置。</p>
  </main>`;
  return htmlResponse(shell('服务未就绪', 'gate', body), 500);
}

export interface RepoView {
  repo: string;
  info: ReleaseInfo | null;
  failure: ReleaseFailure | null;
}

const FAILURE_MESSAGES: Record<ReleaseFailure, string> = {
  rate_limited: 'GitHub API 触发限流（403/429）。请为 Worker 配置 GITHUB_TOKEN，或稍后再试。',
  not_found: '仓库不存在、还没有已发布的 Release，或 token 无权访问该仓库。',
  unauthorized: '访问 GitHub API 被拒绝（401），请检查 GITHUB_TOKEN 是否有效。',
  network: '无法连接 GitHub API，请稍后重试。',
  invalid_response: 'GitHub API 返回了无法解析的数据。',
  upstream_error: 'GitHub API 暂时不可用，请稍后重试。',
};

export interface HomeOptions {
  views: RepoView[];
  sessionMinutes: number;
}

export function renderHome(options: HomeOptions): Response {
  const sections = options.views
    .map((view) => {
      const heading = `<h2>${esc(view.repo)}</h2>`;

      if (!view.info) {
        const reason = view.failure ?? 'upstream_error';
        return `  <section class="repo">
    ${heading}
    <p class="empty">${esc(FAILURE_MESSAGES[reason])}</p>
    <p class="hint">原因代码：<code>${esc(reason)}</code></p>
  </section>`;
      }

      const info = view.info;
      const published = formatDate(info.publishedAt);
      const meta = `<p class="meta"><span class="tag">${esc(info.tag)}</span>${
        published ? ` · 发布于 ${esc(published)}` : ''
      } · ${info.assets.length} 个文件</p>`;

      const assets =
        info.assets.length === 0
          ? '<p class="empty">该版本没有可下载的文件。</p>'
          : `<ul class="assets">${info.assets
              .map((asset) => {
                const href = `/dl/${esc(view.repo)}/${encodeURIComponent(asset.name)}`;
                return `<li>
      <a class="download" href="${href}" rel="nofollow">${esc(asset.name)}</a>
      <span class="size">${esc(formatBytes(asset.size))}</span>
      <a class="button" href="${href}" rel="nofollow">下载</a>
    </li>`;
              })
              .join('')}</ul>`;

      return `  <section class="repo">
    ${heading}
    ${meta}
    ${assets}
  </section>`;
    })
    .join('\n');

  const body = `  <main class="wrap">
    <div class="notice">
      验证会话有效期约 ${options.sessionMinutes} 分钟。下载链接仅能访问下方白名单仓库的最新 Release。
      <a class="button" href="/logout">退出验证</a>
    </div>
${sections}
  </main>`;

  return htmlResponse(shell('Release 下载', 'home', body));
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': HTML_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
