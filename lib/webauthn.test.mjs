import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  PI_WEB_CHALLENGE_MAX_AGE,
  createChallengeToken,
  defaultPasskeyName,
  isWebAuthnSecureContext,
  readChallengeToken,
  webAuthnRequestContext,
  webAuthnUserId,
} = await jiti.import("./webauthn.ts");

const SECRET = "secret";
const NONCE = "a".repeat(16);
const CHALLENGE = "A".repeat(43);

function request(path = "/api/web-auth/passkey/login/options", headers = {}) {
  return new Request(`http://localhost${path}`, { headers });
}

test("round-trips a challenge and binds it to the ceremony", () => {
  const token = createChallengeToken(SECRET, "registration", CHALLENGE, 1_000, NONCE);
  assert.equal(readChallengeToken(token, SECRET, "registration", 1_000), CHALLENGE);
  assert.equal(readChallengeToken(token, SECRET, "authentication", 1_000), null);
});

test("rejects expired, tampered, and foreign challenges", () => {
  const token = createChallengeToken(SECRET, "registration", CHALLENGE, 1_000, NONCE);
  assert.equal(readChallengeToken(token, "other", "registration", 1_000), null);
  assert.equal(readChallengeToken(`${token.slice(0, -1)}0`, SECRET, "registration", 1_000), null);
  assert.equal(
    readChallengeToken(token, SECRET, "registration", 1_000 + PI_WEB_CHALLENGE_MAX_AGE * 1000),
    null,
  );
  assert.equal(readChallengeToken(undefined, SECRET, "registration", 1_000), null);
});

test("resolves the relying party from the Host header and forwarded scheme", () => {
  assert.deepEqual(
    webAuthnRequestContext(request("/", { Host: "pi.example.com" })),
    { rpId: "pi.example.com", origin: "http://pi.example.com" },
  );
  assert.deepEqual(
    webAuthnRequestContext(request("/", { Host: "Pi.Example.com:8443", "X-Forwarded-Proto": "https" })),
    { rpId: "pi.example.com", origin: "https://pi.example.com:8443" },
  );
  assert.equal(webAuthnRequestContext(request("/")), null);
});

test("only treats HTTPS and loopback as secure contexts", () => {
  assert.equal(isWebAuthnSecureContext({ rpId: "localhost", origin: "http://localhost" }), true);
  assert.equal(isWebAuthnSecureContext({ rpId: "127.0.0.1", origin: "http://127.0.0.1" }), true);
  assert.equal(isWebAuthnSecureContext({ rpId: "192.168.1.5", origin: "http://192.168.1.5" }), false);
  assert.equal(isWebAuthnSecureContext({ rpId: "pi.example.com", origin: "https://pi.example.com" }), true);
});

test("derives a stable user handle per relying party", () => {
  assert.deepEqual(webAuthnUserId("localhost"), webAuthnUserId("localhost"));
  assert.notDeepEqual(webAuthnUserId("localhost"), webAuthnUserId("example.com"));
  assert.equal(webAuthnUserId("localhost").length, 32);
});

test("labels passkeys by platform and date", () => {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(
    defaultPasskeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", now),
    "Passkey · macOS · 2026-01-02",
  );
  assert.equal(defaultPasskeyName(null, now), "Passkey · 2026-01-02");
});
