# Security Policy

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**:

1. Open the repository's **Security** tab
2. Click **Report a vulnerability**
3. Describe the issue and, if possible, include a minimal reproduction

Do **not** open a public issue, pull request, or discussion for a security
problem. If private reporting is unavailable, contact the maintainer through
their GitHub profile before disclosing anything publicly.

## In scope

Anything that lets a client bypass the intended access control, including:

- Downloading an asset (`/dl/*`) without a valid, unexpired signed session
- Forging or replaying a session cookie (HMAC bypass, signature confusion)
- Bypassing Turnstile verification server-side (e.g. token reuse across hosts)
- SSRF: making the Worker fetch an attacker-controlled host or URL
- Path traversal / path confusion that reaches a non-release asset
- Escaping the redirect allowlist (`github.com` / `*.githubusercontent.com`)
- Open redirect through the `next` parameter
- Leaking secrets (session signing key, Turnstile secret, GitHub token)
- XSS or CSP bypass in the rendered pages
- Cross-site request/hotlink access to gated routes

## Out of scope

- Requests to unknown paths returning 404, or scanner noise in general
- Rate-limit tuning, missing CAPTCHA on non-gated routes, or DoS/brute force
- Cloudflare platform behaviour, IP reputation, or regional network blocking
- Deployments by third parties that use Turnstile **test keys** or an empty
  allowlist; those are documented misconfigurations, not vulnerabilities
- Terms-of-service questions about proxying large files (see the README)
- Issues that only reproduce with a forked/modified copy of the code

## Response

This is a small, best-effort project. Reports are usually acknowledged within a
few days. There is no bug bounty. Once a fix is released, you are welcome to
publish details; please give the maintainer a reasonable window first.
