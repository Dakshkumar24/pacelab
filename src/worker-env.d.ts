// Secrets are set with `wrangler secret put` and so are absent from
// wrangler.jsonc, which is what `wrangler types` generates env.d.ts from.
// Declare them here so the Worker's env stays typed.
interface Env {
  /** Shared passphrase a person types to reach the testbench. */
  PACELAB_PASSPHRASE?: string;
  /** High-entropy HMAC signing key for session tokens. Never typed by a person. */
  PACELAB_TOKEN_SECRET?: string;
}
