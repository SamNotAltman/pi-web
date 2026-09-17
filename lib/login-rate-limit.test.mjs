import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./login-rate-limit.ts");
}

test("prefers Cloudflare's connecting IP over spoofable forwarding headers", async () => {
  const { clientIpFromRequest } = await loadSubject();
  const request = new Request("http://localhost/api/web-auth", {
    headers: {
      "cf-connecting-ip": "203.0.113.9",
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "192.0.2.1, 198.51.100.2",
    },
  });
  assert.equal(clientIpFromRequest(request), "203.0.113.9");
});

test("falls back to the first forwarded hop, then local", async () => {
  const { clientIpFromRequest } = await loadSubject();
  assert.equal(clientIpFromRequest(new Request("http://localhost/api/web-auth", {
    headers: { "x-forwarded-for": " 192.0.2.8, 198.51.100.8" },
  })), "192.0.2.8");
  assert.equal(clientIpFromRequest(new Request("http://localhost/api/web-auth")), "local");
  assert.equal(clientIpFromRequest(new Request("http://localhost/api/web-auth", {
    headers: { "cf-connecting-ip": "not an ip address" },
  })), "local");
});

test("locks an address after too many failures and clears on success", async () => {
  const {
    isLoginAttemptLimited,
    recordLoginFailure,
    clearLoginFailures,
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  } = await loadSubject();
  const key = `test-${Date.now()}-${Math.random()}`;

  for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS - 1; i += 1) {
    assert.equal(recordLoginFailure(key).limited, false);
  }
  assert.equal(isLoginAttemptLimited(key).limited, false);
  assert.equal(recordLoginFailure(key).limited, true);
  const limited = isLoginAttemptLimited(key);
  assert.equal(limited.limited, true);
  assert.ok(limited.retryAfterSec >= 1);

  clearLoginFailures(key);
  assert.equal(isLoginAttemptLimited(key).limited, false);
});
