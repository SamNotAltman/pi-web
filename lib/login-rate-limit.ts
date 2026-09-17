const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_IP_LENGTH = 64;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let ops = 0;

function normalizeIp(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_IP_LENGTH) return null;
  if (!/^[\w.:%-]+$/.test(trimmed)) return null;
  return trimmed;
}

function prune(now: number): void {
  if (++ops % 32 !== 0 && buckets.size < 1024) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function bucket(key: string, now: number): Bucket | undefined {
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.delete(key);
    return undefined;
  }
  return current;
}

/** Prefer Cloudflare's connecting IP; fall back to common proxy headers. */
export function clientIpFromRequest(request: Request): string {
  const cf = normalizeIp(request.headers.get("cf-connecting-ip"));
  if (cf) return cf;
  const real = normalizeIp(request.headers.get("x-real-ip"));
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0];
  return normalizeIp(forwarded) ?? "local";
}

export function isLoginAttemptLimited(key: string, now = Date.now()): {
  limited: boolean;
  retryAfterSec: number;
} {
  prune(now);
  const current = bucket(key, now);
  if (!current || current.count < MAX_ATTEMPTS) {
    return { limited: false, retryAfterSec: 0 };
  }
  return {
    limited: true,
    retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export function recordLoginFailure(key: string, now = Date.now()): {
  limited: boolean;
  retryAfterSec: number;
} {
  prune(now);
  const current = bucket(key, now);
  if (!current) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { limited: false, retryAfterSec: 0 };
  }
  current.count += 1;
  if (current.count < MAX_ATTEMPTS) {
    return { limited: false, retryAfterSec: 0 };
  }
  return {
    limited: true,
    retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export function clearLoginFailures(key: string): void {
  buckets.delete(key);
}

export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = MAX_ATTEMPTS;
export const LOGIN_RATE_LIMIT_WINDOW_MS = WINDOW_MS;

export function loginRateLimitResponseInit(retryAfterSec: number) {
  return {
    status: 429 as const,
    headers: {
      "Retry-After": String(retryAfterSec),
      "Cache-Control": "no-store",
    },
  };
}
