# cloudflare_ghrelease_wroker

Cloudflare Worker：**先通过 Turnstile 人机验证，再代理下载 GitHub 最新 Release**。

- 白名单仓库：`example/app`（在 `wrangler.jsonc` 的 `REPOS` 中修改，逗号分隔，最多 20 个）
- 只代理 `/releases/latest`，不支持任意 tag、不支持任意 URL
- 运行时零依赖；发布配置只在本地，仓库里是占位符模板
- 181 个测试覆盖路径穿越、伪造会话、恶意重定向等绕过场景

---

## 请求流程

```
浏览器
 ├─ GET /                        → 验证页（Turnstile widget）
 ├─ POST /api/verify {token,next} → 服务端 siteverify → 下发 HMAC 签名 Cookie（默认 60 分钟）
 ├─ GET /                        → 已验证：列出白名单仓库的最新 Release 资产
 ├─ GET /api/releases            → 已验证：JSON 元数据
 ├─ GET /admin*                  → 独立管理鉴权（ADMIN_TOKEN），不经过下载门禁
 └─ GET /dl/{owner}/{repo}/{asset}
        ├─ 1. 校验签名 Cookie（HMAC-SHA256 + 过期时间 + 可选 IP 绑定）
        ├─ 2. owner/repo 必须在 REPOS 白名单
        ├─ 3. asset 必须精确命中 latest release 的 assets[].name
        ├─ 4. 回源 GitHub（manual redirect，逐跳校验 GitHub 域名）
        └─ 5. 流式回传（透传 Range / 206，可断点续传）
```

未验证时用浏览器打开下载链接会先显示验证页，验证通过后自动跳回原链接；`curl` 等非 HTML 客户端直接得到 `401`。

## 安全模型

| 风险 | 处理 |
| --- | --- |
| 绕过验证直接下载 | 门禁在 `/dl/*` 路由内部第一行执行，未通过不会发起任何回源请求 |
| SSRF / 任意 URL | 上游 host 硬编码，没有任何 `?url=` 参数 |
| 路径穿越 `..`、`%2e%2e`、`%252e`、`%2f`、`%00`、反斜杠 | 不拼接原始 path；按 `/` 切段、只解码一次、逐段白名单正则校验后用 `encodeURIComponent` 重建 |
| 下载非 release 文件 | 资产名必须与 GitHub API 返回的资产列表精确相等 |
| 重定向劫持 | `redirect: "manual"`，逐跳校验 `https` + GitHub 域名（严格 label 边界），最多 3 跳 |
| 伪造 / 重放 Cookie | HMAC 密钥缺失时 fail-closed（500）；签名含 `exp`/`jti`；Turnstile token 一次性 |
| 跨站盗链 | `SameSite=Lax` + 无 CORS 头 + `Cross-Origin-Resource-Policy: same-origin` |
| 备用入口 | `workers_dev=false`、`preview_urls=false`，只有自定义域名可达 |
| 开放重定向 | `next` 只接受站内绝对路径，解析后二次校验 origin |
| 跨站提交验证 | 校验 `Origin`；siteverify 返回的 `hostname` 必须与本站一致 |
| 方法滥用 | 仅 `GET` / `HEAD` / `POST`（`POST` 仅用于 `/api/verify`） |
| HTTP 降级 | 边缘标记为 `http` 的请求一律 308 升级到 HTTPS（保留方法与 body），HTTPS 响应带 HSTS；`wrangler dev` 不触发 |
| 缓存泄露 | 页面与 API `no-store`；下载响应 `private, no-store` |
| 滥用刷量 | 每 IP 验证 10 次/小时、下载 200 次/小时（KV，best-effort） |
| 管理页越权 | 独立 `ADMIN_TOKEN` + `a1.` 前缀签名 Cookie（下载会话无法复用）；未配置令牌时 `/admin*` 返回 404；登录按 IP 限流 |

其他默认响应头：`X-Content-Type-Options`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`X-Robots-Tag: noindex`、CSP。

## 目录结构

```
.
├─ wrangler.example.jsonc    部署配置模板（占位符，入库）
├─ wrangler.jsonc            真实部署配置（gitignore，本地填写）
├─ biome.json                Biome lint + format 配置
├─ worker-configuration.d.ts 由 `npm run types` 生成
├─ vitest.config.ts          测试环境（Cloudflare Workers runtime，使用 example 配置）
├─ .dev.vars                 本地开发密钥（gitignore）
├─ .dev.vars.example         本地开发模板
├─ scripts/
│  ├─ bootstrap.mjs          首次运行自动复制模板
│  ├─ check-config.mjs       部署前结构校验（域名/仓库/KV/DO）
│  ├─ analyze-logs.mjs       缓存收益分析（读 wrangler tail NDJSON）
│  └─ lib/analyze.mjs        纯函数：解析 / TTL 回放 / 汇总
├─ shared/stats.mjs          管理页与离线脚本共用的 TTL 回放
├─ .github/workflows/ci.yml  CI：check + lint + types + coverage + dry-run
├─ .github/dependabot.yml    依赖与 Actions 周更
├─ SECURITY.md               漏洞报告流程
├─ LICENSE                   MIT
├─ src/
│  ├─ index.ts               路由 + 全局安全头 + fail-closed
│  ├─ verify.ts              Turnstile 服务端校验 + 签发 Cookie
│  ├─ download.ts            资产校验 + 重定向校验 + 流式回源
│  ├─ release.ts             GitHub API + Cache API（5 分钟新鲜 / 24 小时陈旧兜底）
│  ├─ metrics-do.ts          下载事件存储 + 聚合（SQLite Durable Object）
│  ├─ admin.ts               管理登录 / 统计页 / CSV / JSON
│  ├─ ui.ts                  服务端渲染页面（全部转义）
│  ├─ ui-admin.ts            管理页与登录页
│  ├─ assets.ts              内联 app.js / style.css
│  ├─ env.d.ts               补充 secrets 类型
│  └─ lib/
│     ├─ auth.ts             HMAC 会话 + 管理员令牌
│     ├─ config.ts           数值配置解析 + clamp
│     ├─ http.ts             通用 JSON / 文本 / 重定向响应
│     ├─ security.ts         路径 / URL / Range / 文件名校验
│     └─ ratelimit.ts        KV 限流
└─ test/                     181 个测试（含绕过用例）
```

## 本地开发

```powershell
npm install
npm run dev          # 首次会自动从 example 生成 wrangler.jsonc / .dev.vars，然后 http://127.0.0.1:8787
```

`wrangler.jsonc` 与 `.dev.vars` 都不入库：前者放你的域名 / KV id / Site Key，后者放本地密钥。
`.dev.vars.example` 默认使用 Cloudflare 官方 **Turnstile 测试密钥**（永远通过），可以直接点开验证页走完整流程。

```powershell
npm run bootstrap    # 手动生成缺失的 wrangler.jsonc / .dev.vars
npm run check        # tsc --noEmit
npm run lint         # biome check（格式 + lint）
npm test             # vitest（Workers runtime）
npm run test:coverage  # vitest + V8 覆盖率（有门槛）
npm run types:check  # 校验 worker-configuration.d.ts 是否过期
npm run types        # 修改 wrangler.jsonc 后重新生成 Env 类型
```


## 部署步骤

0. **生成本地配置**

   ```powershell
   npm run bootstrap     # 从 example 复制出 wrangler.jsonc
   ```

   `wrangler.jsonc` 已被 gitignore，只存在于你的机器上；仓库里提交的是 `wrangler.example.jsonc`。

1. **创建 KV namespace**

   ```powershell
   npx wrangler kv namespace create RATE_LIMIT
   ```

   把输出的 `id` 填进 `wrangler.jsonc` 的 `kv_namespaces[0].id`（占位符 `0000...` 不替换会导致部署失败）。

2. **创建 Turnstile widget**

   Cloudflare Dashboard → Turnstile → Add widget：
   - Hostname：你的自定义域名（例如 `dl.example.com`）
   - Widget mode：Managed
   - 记下 **Site Key**（公开）和 **Secret Key**

   把 Site Key 填进 `wrangler.jsonc` 的 `vars.TURNSTILE_SITE_KEY`（未填时首页会显示“服务未就绪”）。
   同时把 `routes[0].pattern` 改成你的域名、`REPOS` 改成要代理的仓库。

3. **写入 secrets**

   ```powershell
   npx wrangler secret put TURNSTILE_SECRET
   # 生成会话密钥（32 字节 hex）
   [Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
   npx wrangler secret put SESSION_SECRET
   # 管理页登录令牌（>= 16 字符，建议 32）
   [Convert]::ToHexString((1..24 | ForEach-Object { Get-Random -Maximum 256 }))
   npx wrangler secret put ADMIN_TOKEN
   ```

   可选（把 GitHub API 配额从 60/h 提到 5000/h）：

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   ```

4. **部署**

   ```powershell
   npx wrangler login     # 首次需要浏览器授权
   npm run deploy
   ```

   `routes` 已配置为 `dl.example.com`（`custom_domain: true`）。域名的 zone 必须在同一个 Cloudflare 账号下，Wrangler 会自动创建 DNS 记录和证书。

5. **验收**

   ```powershell
   curl.exe -i https://dl.example.com/healthz
   curl.exe -i https://dl.example.com/dl/example/app/xxx.zip   # 应返回 401
   ```

   浏览器打开首页 → 完成人机验证 → 看到 Release 列表 → 下载。

## 配置项（wrangler.jsonc vars）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `REPOS` | `example/app` | 逗号分隔的白名单，最多 20 个 |
| `TURNSTILE_SITE_KEY` | 空 | Turnstile Site Key |
| `SESSION_TTL_SECONDS` | `3600` | 会话有效期，限制在 300–7200 秒 |
| `RELEASE_CACHE_TTL` | `300` | Release 元数据缓存秒数 |
| `VERIFY_LIMIT_PER_HOUR` | `10` | 每 IP 每小时验证次数 |
| `DOWNLOAD_LIMIT_PER_HOUR` | `200` | 每 IP 每小时下载次数 |
| `ADMIN_LIMIT_PER_HOUR` | `10` | 每 IP 每小时管理登录尝试次数 |
| `METRICS_RETENTION_DAYS` | `30` | 下载事件保留天数（1–30，与管理页区间一致） |

Secrets：`TURNSTILE_SECRET`、`SESSION_SECRET`、`ADMIN_TOKEN`（均必需）、`GITHUB_TOKEN`（可选）、`SESSION_BIND_IP=1`（可选，把会话绑定到 IP + UA）。

修改 `REPOS` 等变量后重新 `npm run deploy` 即可；修改了绑定结构再跑一次 `npm run types`。首次部署会创建 `MetricsDO`（`migrations` 里的 `v1` 会由 Wrangler 自动应用）。

## 管理页与统计

`/admin` 是独立入口，**不在下载页放链接**，也不会被下载会话或 Turnstile 放行：

| 路由 | 说明 |
| --- | --- |
| `GET /admin/login` | 输入 `ADMIN_TOKEN` 的表单 |
| `POST /admin/login` | 校验令牌，下发 12 小时 `dl_admin` Cookie（`HttpOnly; Secure; SameSite=Strict; Path=/admin`） |
| `GET /admin?range=24h\|7d\|30d` | 统计页：请求数、可缓存数、字节、TTL 命中率/回源占比、按仓库/资产、按 colo、TTFB p50/p95 |
| `GET /admin/data.json` | 同一份数据的 JSON（需管理员 Cookie） |
| `GET /admin/export.csv` | 按仓库/资产的 CSV 导出 |
| `GET /admin/logout` | 清除管理员 Cookie |

实现方式：

- 每次通过验证的下载（200/206）写入一个 SQLite Durable Object（`MetricsDO`），只记 `colo / country / asn / repo / tag / asset / size / status / range / upstreamMs`，**不记 IP、Cookie、token**
- `METRICS_RETENTION_DAYS` 到期自动清理（每天由 DO alarm 执行，不依赖下载量）
- TTL 命中率与 `npm run analyze` 使用同一份 `shared/stats.mjs`，两边口径一致（按 colo + 仓库 + 资产回放）
- `ADMIN_TOKEN` 未配置时 `/admin*` 直接 404；登录失败按 IP 限流；令牌比较使用 SHA-256 摘要 + 常量时间比较
- 管理员 Cookie 使用独立的 `a1.` 前缀，下载会话的 `v1.` 令牌无法当作管理员令牌使用

统计口径（避免误读）：

- 只记录**通过校验且回源成功**的下载（200/206）；401、404、扫描流量不进入统计
- `bytes` 取 Release 资产的 `size`，Range（206）只传了部分字节但按整文件累加
- TTL 命中率是“如果加缓存”的**模拟值**，不是真实缓存命中率
- 单次查询最多 5 万行，超出时保留**最新**事件；窗口与保留期均为 30 天
- 聚合键是 `repo + asset`，不同仓库的同名资产不会合并

> 如果启用了“减少扫描流量”里的 WAF 放行规则，记得把 `/admin` 和 `/admin/*` 加进去，否则管理页会被边缘拦截。

## 测试覆盖

`npm test` 共 181 个用例，包含：

- 未带 Cookie / 伪造签名 / 篡改 payload / 换密钥签名 / 过期会话 → 401，且断言 **0 次回源**
- `..%2f`、`%252e%252e`、`%2f`、`%5c`、`%00`、超长段、多余段、尾斜杠 → 400/404，且 0 次回源
- 非白名单仓库、非 release 资产 → 404
- 上游 302 到 `evil.example`、`evil-githubusercontent.com` → 502，且不会请求恶意域
- 上游 302 到 `release-assets.githubusercontent.com` → 200，Range → 206，HEAD 无 body
- 上游返回 `text/html` 伪装资产 → 502
- Turnstile 成功 / 失败 / hostname 不匹配 / 跨站 Origin / 非法 token
- `next=//evil`、`next=https://evil`、`javascript:` 等开放重定向 → 归一为 `/`
- 会话签发 → 真实下载链路贯通
- HTTP → HTTPS 308 升级、HSTS、本地开发豁免
- 日志解析与 TTL 回放（含 Range / 非 200 / 跨 colo / 跨资产隔离）

## 减少扫描流量

公开域名一定会被全网扫描（证书透明日志会立刻暴露新 hostname）。这些请求本身不会碰到 GitHub：
未知路径直接 404，`/dl/*` 没有有效会话直接 401。但它们会消耗 Worker 调用次数并刷满日志。

推荐在 Cloudflare Dashboard 加两层边缘规则（免费套餐够用）：

1. **Security → WAF → Custom rules**（免费 5 条）：只放行本站路由，其余直接 Block。

   ```
   not (
     http.request.uri.path in {"/" "/healthz" "/robots.txt" "/logout" "/api/verify" "/api/releases" "/assets/app.js" "/assets/style.css" "/admin"}
     or starts_with(http.request.uri.path, "/dl/")
     or starts_with(http.request.uri.path, "/admin/")
   )
   ```

2. **Security → WAF → Rate limiting rules**（免费 1 条）：限制验证接口。

   ```
   http.request.uri.path eq "/api/verify"
   ```

   10 次 / 1 分钟 / IP，Action 选 Block 或 Managed Challenge。

3. 可选：**Security → Bots** 打开 Bot Fight Mode。

`wrangler.jsonc` 里 `observability.head_sampling_rate` 已设成 `0.1`，日志只保留 10% 采样，避免被扫描流量刷屏。这个采样只影响 Dashboard 的 Workers Logs；`wrangler tail` 不受影响，排障时优先用 tail。

## 测量缓存收益（可选）

Worker 默认不缓存下载内容，所以 Dashboard 的缓存命中率是 0%——这是“动态鉴权代理”的正常形态。**要不要加缓存，先用日志算一遍**，不要凭感觉。

每个通过验证的下载会打一条结构化日志（不含 IP / Cookie / token）：

```json
{"evt":"dl","colo":"SJC","country":"CN","asn":4134,"repo":"example/app","tag":"v1.0.0","asset":"app.zip","size":65001387,"status":200,"range":false,"redirects":1,"upstreamMs":412,"handlerMs":780}
```

采集与分析：

```powershell
# 1) 落文件（用 cmd 重定向，避免 PowerShell 写出 UTF-16）
cmd /c "npx wrangler tail --format json > tail.ndjson"

# 2) 正常使用站点，累计若干次下载后 Ctrl+C

# 3) 回放一个 TTL 缓存，看本可以命中多少
npm run analyze -- tail.ndjson --ttl 3600,21600,86400
```

输出示例：

```
下载事件: 128 条（成功且非 Range: 121 条）
Colo 分布: SJC=90  HKG=30  NRT=8
回源 TTFB: p50=0.42s  p95=1.10s

按 TTL 模拟（同一 colo + 同一仓库 + 同一资产的重复请求视为可命中）:
  TTL      命中    未命中   命中率    回源占比   可省字节
  1h       18      103     14.9%     85.1%     1.1 GB
  6h       41      80      33.9%     66.1%     2.5 GB

[提示] 成功下载只有 121 条（少于 50），结论仅供参考；建议继续采集。
```

判据：24h 命中率低于 30%，或回源 TTFB p50 低于 300ms，说明加缓存的收益抵不过复杂度和 Cloudflare 条款风险，保持现状即可。`*.ndjson` 已在 `.gitignore` 中。

## 限制与风险

- **Cloudflare 服务条款 2.8**：用 CDN 代理“不成比例的大量非 HTML 内容（大文件）”存在被限制的风险。个人小流量通常无碍，但请自行评估；白名单 + 限流可降低风险。
- **免费套餐**：10 万请求/日。大文件按请求计，不按字节计，但流量会消耗你的账户额度。
- **GitHub API 配额**：未认证 60 次/小时/IP（Cloudflare 出口 IP 共享）。已用 Cache API 缓存 5 分钟，并在 API 失败时回退到 24 小时内的旧数据；长期使用建议配置 `GITHUB_TOKEN`。
- **大文件**：Worker 流式转发不缓存到磁盘，支持 `Range` 断点续传；但极慢的客户端可能被链路中断，重试即可续传。
- **“加速”原理**：由 Cloudflare 边缘节点回源 GitHub 再回传给你，规避本地到 GitHub 的劣质线路；不是传统 CDN 缓存。
- **会话共享**：验证后 60 分钟内 Cookie 可被主动分享，因此配合了每 IP 下载限流；如需更严可设 `SESSION_BIND_IP=1`。
- `compatibility_date` 固定为 `2026-08-22`，与测试运行时一致；升级 Wrangler 后可自行上调。

## 常见问题

| 现象 | 原因 |
| --- | --- |
| 首页“服务未就绪” | `TURNSTILE_SITE_KEY` 为空、`TURNSTILE_SECRET` / `SESSION_SECRET` 未设置 |
| 验证一直失败 | 站点密钥与 Secret 不匹配，或 Turnstile widget 的 hostname 与访问域名不一致 |
| 首页 `reason=rate_limited` / `{"error":"release_unavailable","reason":"rate_limited"}` | GitHub API 403/429 限流（Cloudflare 共享出口 IP 很容易触发）。配置 `GITHUB_TOKEN` 即可 |
| `reason=not_found` | 仓库不存在、没有已发布 Release，或 token 无权访问 |
| `reason=network` / `upstream_error` | GitHub 网络或服务端异常，查看 `npx wrangler tail` |
| `{"error":"asset_not_found"}` | 资产名不在最新 Release 中（或最新 Release 已更新） |
| 部署报 KV namespace not found | 未替换 `wrangler.jsonc` 里的 KV 占位 id |
| 管理登录报“来源不被允许” | 已兼容 `Origin: null`（HTTP→HTTPS 表单升级）和 http/https 同 host 差异；仍出现时看 `wrangler tail` 里的 `admin login origin mismatch` |
| 用 `http://` 打开会反复弹人机验证 | 会话 Cookie 带 `Secure`，HTTP 下浏览器不会保存。Worker 会把非本地 HTTP 请求 308 到 HTTPS；再建议在 Cloudflare 开 Always Use HTTPS 或加一条 Redirect Rule |
| 大量 `/.env`、`/wp-admin` 之类请求 | 全网扫描，未知路径直接 404、不会回源；用 WAF 规则挡在边缘，见“减少扫描流量” |

排查线上问题时用 `npx wrangler tail`，日志会打印 GitHub 状态码、是否带 token、`x-ratelimit-remaining/reset`。

## 免责声明

- 本项目只用于加速**你自己拥有、或已获得公开分发授权**的 Release 产物。
- 请自行确认符合 [Cloudflare 服务条款](https://www.cloudflare.com/terms/)（尤其是关于大体积非 HTML 内容的部分）与 [GitHub 服务条款](https://docs.github.com/site-policy/github-terms/github-terms-of-service)。
- 不要使用 Turnstile 官方测试密钥部署生产环境；不要提交 `wrangler.jsonc`、`.dev.vars` 或任何真实密钥。
- 软件按 MIT 协议“按原样”提供，不附带任何可用性、安全性或合规性担保。

安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告，不要开公开 issue。

## License

[MIT](./LICENSE) © 2026 com-wuqi
