/**
 * Access gate for the deployed testbench.
 *
 * The worker is on a public workers.dev URL, so without a gate anyone with the
 * link could open a voice call and spend the account's daily Workers AI
 * allowance. A shared passphrase is checked once; the worker then issues a
 * short-lived token that the browser returns in an HttpOnly cookie, so the
 * token never appears in a URL and so never reaches a request log.
 *
 * Two separate secrets, both Worker secrets and neither ever sent to the
 * browser:
 *   PACELAB_PASSPHRASE   - what a person types. Human-chosen, low entropy.
 *   PACELAB_TOKEN_SECRET - the HMAC signing key. High entropy, never typed.
 * Keeping them apart means a weak passphrase does not weaken the signing key,
 * and the passphrase can be changed without invalidating the key or vice versa.
 */

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64url(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message))
  );
}

/** Constant-time comparison, so a wrong value cannot be found by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Compare the supplied passphrase with the stored one. Both sides are hashed
 * under the signing key first: equal-length digests keep the comparison
 * constant-time whatever the inputs look like.
 */
export async function checkPassphrase(
  supplied: string,
  passphrase: string,
  signingKey: string
): Promise<boolean> {
  const [x, y] = await Promise.all([
    hmac(signingKey, `pass:${supplied}`),
    hmac(signingKey, `pass:${passphrase}`)
  ]);
  return timingSafeEqual(x, y);
}

/** token = <expiry ms>.<signature over that expiry> */
export async function mintToken(
  signingKey: string,
  ttlMs: number
): Promise<string> {
  const exp = String(Date.now() + ttlMs);
  return `${exp}.${await hmac(signingKey, `tok:${exp}`)}`;
}

export async function verifyToken(
  token: string | null | undefined,
  signingKey: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: "not signed in" };
  const dot = token.indexOf(".");
  if (dot < 1) return { ok: false, reason: "malformed session" };
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return { ok: false, reason: "malformed session" };
  const expected = await hmac(signingKey, `tok:${exp}`);
  if (!timingSafeEqual(sig, expected)) {
    return { ok: false, reason: "invalid session" };
  }
  if (Number(exp) < Date.now()) return { ok: false, reason: "session expired" };
  return { ok: true };
}

/**
 * A stable, non-reversible handle for one client, used only to count failed
 * passphrase attempts. The raw IP address is never stored.
 */
export async function clientHandle(
  request: Request,
  signingKey: string
): Promise<string> {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for") ??
    "unknown";
  return (await hmac(signingKey, `ip:${ip}`)).slice(0, 32);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(
  name: string,
  value: string,
  ttlMs: number,
  secure: boolean
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(ttlMs / 1000)}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
