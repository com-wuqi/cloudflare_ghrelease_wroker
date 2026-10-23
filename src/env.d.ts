// Secrets are not present in wrangler.jsonc, so they are not part of the
// generated Env interface. This declaration merges them in.
interface Env {
  SESSION_SECRET?: string;
  TURNSTILE_SECRET?: string;
  GITHUB_TOKEN?: string;
  SESSION_BIND_IP?: string;
}
