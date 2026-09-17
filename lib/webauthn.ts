import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * Short-lived, signed cookie that carries the WebAuthn challenge between the
 * options and verify requests. Signing keeps the flow stateless: the server
 * still holds no per-ceremony state, matching the password session tokens.
 */
export const PI_WEB_CHALLENGE_COOKIE = "pi_web_webauthn_challenge";
export const PI_WEB_CHALLENGE_MAX_AGE = 5 * 60;

export type WebAuthnCeremony = "registration" | "authentication";

export interface WebAuthnRequestContext {
  /** Relying party ID: the bare hostname the browser is talking to. */
  rpId: string;
  /** Expected browser origin, including scheme and non-default port. */
  origin: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Resolve the relying party from the request the browser actually made. The
 * Host header wins over the server URL because proxies and tunnels terminate
 * TLS in front of the app; `x-forwarded-proto` carries the external scheme.
 */
export function webAuthnRequestContext(request: Request): WebAuthnRequestContext | null {
  const host = request.headers.get("host");
  if (!host) return null;

  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return null;
  }
  if (!parsed.hostname || parsed.username || parsed.password) return null;

  const forwarded = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const protocol = forwarded === "https" || forwarded === "http"
    ? forwarded
    : new URL(request.url).protocol.replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https") return null;

  return { rpId: parsed.hostname, origin: `${protocol}://${parsed.host}` };
}

/** WebAuthn only runs in a secure context: HTTPS, localhost, or loopback. */
export function isWebAuthnSecureContext(context: WebAuthnRequestContext): boolean {
  try {
    if (new URL(context.origin).protocol === "https:") return true;
  } catch {
    return false;
  }
  return isLoopbackHostname(context.rpId);
}

/** Stable 32-byte user handle, so re-registering does not fork the account. */
export function webAuthnUserId(rpId: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(`pi-web:${rpId}`, "utf8").digest();
  const bytes = new Uint8Array(digest.byteLength);
  bytes.set(digest);
  return bytes;
}

function challengeSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`pi-web-webauthn:${payload}`, "utf8").digest("hex");
}

export function createChallengeToken(
  secret: string,
  ceremony: WebAuthnCeremony,
  challenge: string,
  now = Date.now(),
  nonce = randomBytes(8).toString("hex"),
): string {
  const expiresAt = Math.floor(now / 1000) + PI_WEB_CHALLENGE_MAX_AGE;
  const payload = `v1.${ceremony}.${expiresAt}.${challenge}.${nonce}`;
  return `${payload}.${challengeSignature(payload, secret)}`;
}

/** Returns the challenge the token carries, or null if it is invalid/expired. */
export function readChallengeToken(
  token: string | undefined,
  secret: string,
  ceremony: WebAuthnCeremony,
  now = Date.now(),
): string | null {
  if (!token) return null;
  const match = /^(v1\.(registration|authentication)\.(\d+)\.([A-Za-z0-9_-]{16,128})\.[a-f0-9]{16})\.([a-f0-9]{64})$/.exec(token);
  if (!match || match[2] !== ceremony) return null;

  const expiresAt = Number(match[3]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return null;

  const expected = challengeSignature(match[1], secret);
  return timingSafeEqual(Buffer.from(match[5], "hex"), Buffer.from(expected, "hex"))
    ? match[4]
    : null;
}

export function challengeCookieOptions(request: Request) {
  return {
    name: PI_WEB_CHALLENGE_COOKIE,
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: new URL(request.url).protocol === "https:"
      || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https",
    path: "/",
  };
}

function platformFromUserAgent(userAgent: string): string | null {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

/** Default label so several passkeys stay distinguishable in the settings list. */
export function defaultPasskeyName(userAgent: string | null, now = Date.now()): string {
  const date = new Date(now).toISOString().slice(0, 10);
  const platform = userAgent ? platformFromUserAgent(userAgent) : null;
  return platform ? `Passkey · ${platform} · ${date}` : `Passkey · ${date}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64Url(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && value.length <= 4096;
}

export function isValidRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  if (!isRecord(value) || value.type !== "public-key" || !isBase64Url(value.id) || !isBase64Url(value.rawId)) {
    return false;
  }
  const response = value.response;
  return isRecord(response)
    && isBase64Url(response.clientDataJSON)
    && isBase64Url(response.attestationObject);
}

export function isValidAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (!isRecord(value) || value.type !== "public-key" || !isBase64Url(value.id) || !isBase64Url(value.rawId)) {
    return false;
  }
  const response = value.response;
  return isRecord(response)
    && isBase64Url(response.clientDataJSON)
    && isBase64Url(response.authenticatorData)
    && isBase64Url(response.signature);
}
