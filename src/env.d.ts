// Secrets and optional vars are not present in wrangler.jsonc, so they are not
// part of the generated Env interface. This declaration merges them in.
interface Env {
  SESSION_SECRET?: string;
  TURNSTILE_SECRET?: string;
  GITHUB_TOKEN?: string;
  SESSION_BIND_IP?: string;
  ADMIN_TOKEN?: string;
  ADMIN_LIMIT_PER_HOUR?: string;
  METRICS_RETENTION_DAYS?: string;
}
