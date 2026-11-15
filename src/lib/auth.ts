/**
 * Access gate for the deployed testbench.
 *
 * The worker is on a public workers.dev URL, so without a gate anyone with the
 * link could open a voice call and spend the account's daily Workers AI
 * allowance. A shared passphrase is checked once; the worker then issues a
 * short-lived HMAC token that the browser presents when it opens the agent
 * WebSocket. Browsers cannot set headers on a WebSocket, so the token travels
 * as a query parameter: it carries no personal data and expires within the hour.
 *
 * The passphrase itself is a Worker secret and is never sent to the browser.
 */

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Constant-time comparison, so a wrong passphrase cannot be found by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkPassphrase(
  supplied: string,
  secret: string
): Promise<boolean> {
  // Hash both sides first: equal-length digests keep the comparison constant-time.
  const [x, y] = await Promise.all([
    hmac(secret, `pass:${supplied}`),
    hmac(secret, `pass:${secret}`)
  ]);
  return timingSafeEqual(x, y);
}

/** token = <expiry ms>.<signature over that expiry> */
export async function mintToken(secret: string, ttlMs: number): Promise<string> {
  const exp = String(Date.now() + ttlMs);
  return `${exp}.${await hmac(secret, `tok:${exp}`)}`;
}

export async function verifyToken(
  token: string | null,
  secret: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: "missing token" };
  const dot = token.indexOf(".");
  if (dot < 1) return { ok: false, reason: "malformed token" };
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return { ok: false, reason: "malformed token" };
  const expected = await hmac(secret, `tok:${exp}`);
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: "bad signature" };
  if (Number(exp) < Date.now()) return { ok: false, reason: "token expired" };
  return { ok: true };
}
