import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-passkey-route-"));
const PASSWORD = "correct horse battery staple";
const RP_ID = "localhost";
const ORIGIN = "http://localhost";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const registerOptions = await jiti.import("./register/options/route.ts");
const registerVerify = await jiti.import("./register/verify/route.ts");
const loginOptions = await jiti.import("./login/options/route.ts");
const loginVerify = await jiti.import("./login/verify/route.ts");
const listRoute = await jiti.import("./route.ts");
const deleteRoute = await jiti.import("./[id]/route.ts");
const { createWebSessionToken } = await jiti.import("@/lib/web-auth.ts");
const { readPasskeys } = await jiti.import("@/lib/passkey-store.ts");

before(() => {
  process.env.PI_WEB_PASSWORD = PASSWORD;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(() => {
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function request(path, { method = "POST", body, cookie, headers = {} } = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: {
      Host: "localhost",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "expected a Set-Cookie header");
  return header.split(";", 1)[0];
}

const base64url = (value) => Buffer.from(value).toString("base64url");

// --- Minimal CBOR encoder, enough for an attestation object and a COSE key. ---
function cborLength(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const buffer = Buffer.alloc(3);
    buffer[0] = (major << 5) | 25;
    buffer.writeUInt16BE(length, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = (major << 5) | 26;
  buffer.writeUInt32BE(length, 1);
  return buffer;
}

const cborInt = (value) => value >= 0 ? cborLength(0, value) : cborLength(1, -1 - value);
const cborBytes = (value) => Buffer.concat([cborLength(2, value.length), value]);
const cborText = (value) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([cborLength(3, bytes.length), bytes]);
};
const cborMap = (entries) => Buffer.concat([cborLength(5, entries.length), ...entries.flat()]);

function coseEc2PublicKey(jwk) {
  return cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(Buffer.from(jwk.x, "base64url"))],
    [cborInt(-3), cborBytes(Buffer.from(jwk.y, "base64url"))],
  ]);
}

/** A software authenticator that produces real WebAuthn responses. */
function createAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    credentialId: randomBytes(32),
    privateKey,
    cosePublicKey: coseEc2PublicKey(jwk),
  };
}

function registrationResponse(authenticator, challenge) {
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(authenticator.credentialId.length, 0);
  const authData = Buffer.concat([
    createHash("sha256").update(RP_ID).digest(),
    Buffer.from([0x41]), // user present + attested credential data
    Buffer.alloc(4), // signature counter
    Buffer.alloc(16), // AAGUID
    credentialIdLength,
    authenticator.credentialId,
    authenticator.cosePublicKey,
  ]);
  const attestationObject = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authData)],
  ]);
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.create",
    challenge,
    origin: ORIGIN,
  }), "utf8");

  return {
    id: base64url(authenticator.credentialId),
    rawId: base64url(authenticator.credentialId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: base64url(clientDataJSON),
      attestationObject: base64url(attestationObject),
      transports: ["internal"],
    },
  };
}

function assertionResponse(authenticator, challenge, counter = 1, origin = ORIGIN) {
  const authData = Buffer.concat([
    createHash("sha256").update(RP_ID).digest(),
    Buffer.from([0x01]), // user present
    Buffer.from([counter >>> 24, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff]),
  ]);
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin,
  }), "utf8");
  const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
  const signature = cryptoSign("sha256", Buffer.concat([authData, clientDataHash]), authenticator.privateKey);

  return {
    id: base64url(authenticator.credentialId),
    rawId: base64url(authenticator.credentialId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authData),
      signature: base64url(signature),
    },
  };
}

const authenticator = createAuthenticator();
let storedCredentialId;

test("rejects cross-origin ceremonies", async () => {
  const response = await loginOptions.POST(request("/api/web-auth/passkey/login/options", {
    body: {},
    headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
  }));
  assert.equal(response.status, 403);
});

test("registration options need the password or an existing session", async () => {
  let response = await registerOptions.POST(request("/api/web-auth/passkey/register/options", { body: {} }));
  assert.equal(response.status, 401);

  response = await registerOptions.POST(request("/api/web-auth/passkey/register/options", {
    body: { password: "wrong" },
  }));
  assert.equal(response.status, 401);

  const session = createWebSessionToken(PASSWORD);
  response = await registerOptions.POST(request("/api/web-auth/passkey/register/options", {
    body: {},
    cookie: `pi_web_session=${session}`,
  }));
  assert.equal(response.status, 200);
});

test("reports that no passkey exists before registration", async () => {
  const response = await loginOptions.POST(request("/api/web-auth/passkey/login/options", { body: {} }));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).hasPasskeys, false);
});

test("registers a passkey against the signed challenge", async () => {
  let response = await registerOptions.POST(request("/api/web-auth/passkey/register/options", {
    body: { password: PASSWORD },
  }));
  assert.equal(response.status, 200);
  const options = await response.json();
  const challengeCookie = cookieFrom(response);
  assert.equal(options.rp.id, RP_ID);
  assert.match(challengeCookie, /^pi_web_webauthn_challenge=v1\.registration\./);

  response = await registerVerify.POST(request("/api/web-auth/passkey/register/verify", {
    body: { response: registrationResponse(authenticator, options.challenge) },
    cookie: challengeCookie,
  }));
  assert.equal(response.status, 200, await response.text());

  const stored = readPasskeys();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].rpId, RP_ID);
  assert.equal(stored[0].id, base64url(authenticator.credentialId));
  assert.deepEqual(stored[0].transports, ["internal"]);
  storedCredentialId = stored[0].id;
});

test("rejects a registration response without a valid challenge cookie", async () => {
  const response = await registerOptions.POST(request("/api/web-auth/passkey/register/options", {
    body: { password: PASSWORD },
  }));
  const options = await response.json();
  const cookie = cookieFrom(response);

  const noCookie = await registerVerify.POST(request("/api/web-auth/passkey/register/verify", {
    body: { response: registrationResponse(createAuthenticator(), options.challenge) },
  }));
  assert.equal(noCookie.status, 400);

  // The challenge is bound to the cookie, so replaying another challenge fails.
  const otherOptions = await registerOptions.POST(request("/api/web-auth/passkey/register/options", {
    body: { password: PASSWORD },
  }));
  const other = await otherOptions.json();
  const mismatched = await registerVerify.POST(request("/api/web-auth/passkey/register/verify", {
    body: { response: registrationResponse(createAuthenticator(), other.challenge) },
    cookie,
  }));
  assert.equal(mismatched.status, 400);
});

test("signs in with the registered passkey and issues a session", async () => {
  let response = await loginOptions.POST(request("/api/web-auth/passkey/login/options", { body: {} }));
  assert.equal(response.status, 200);
  const options = await response.json();
  const challengeCookie = cookieFrom(response);
  assert.deepEqual(options.allowCredentials.map((entry) => entry.id), [storedCredentialId]);

  response = await loginVerify.POST(request("/api/web-auth/passkey/login/verify", {
    body: { response: assertionResponse(authenticator, options.challenge, 5) },
    cookie: challengeCookie,
  }));
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /pi_web_session=v1\./);
  assert.match(cookie, /Max-Age=/i);
  assert.equal(readPasskeys()[0].counter, 5);
  assert.ok(readPasskeys()[0].lastUsedAt);
});

test("rejects an assertion signed for another origin", async () => {
  const response = await loginOptions.POST(request("/api/web-auth/passkey/login/options", { body: {} }));
  const options = await response.json();
  const challengeCookie = cookieFrom(response);

  const badOrigin = await loginVerify.POST(request("/api/web-auth/passkey/login/verify", {
    body: { response: assertionResponse(authenticator, options.challenge, 6, "http://evil.example") },
    cookie: challengeCookie,
  }));
  assert.equal(badOrigin.status, 401);
});

test("rejects an unknown credential id", async () => {
  const response = await loginOptions.POST(request("/api/web-auth/passkey/login/options", { body: {} }));
  const options = await response.json();
  const challengeCookie = cookieFrom(response);

  const unknown = createAuthenticator();
  const rejected = await loginVerify.POST(request("/api/web-auth/passkey/login/verify", {
    body: { response: assertionResponse(unknown, options.challenge) },
    cookie: challengeCookie,
  }));
  assert.equal(rejected.status, 401);
});

test("manages passkeys only with a session", async () => {
  let response = await listRoute.GET(request("/api/web-auth/passkey", { method: "GET" }));
  assert.equal(response.status, 401);

  const sessionCookie = `pi_web_session=${createWebSessionToken(PASSWORD)}`;
  response = await listRoute.GET(request("/api/web-auth/passkey", { method: "GET", cookie: sessionCookie }));
  assert.equal(response.status, 200);
  const { passkeys } = await response.json();
  assert.equal(passkeys.length, 1);
  assert.equal(typeof passkeys[0].name, "string");
  assert.equal(passkeys[0].publicKey, undefined);

  const missing = await deleteRoute.DELETE(
    request("/api/web-auth/passkey/missing", { method: "DELETE", cookie: sessionCookie }),
    { params: Promise.resolve({ id: "missing" }) },
  );
  assert.equal(missing.status, 404);

  const removed = await deleteRoute.DELETE(
    request(`/api/web-auth/passkey/${storedCredentialId}`, { method: "DELETE", cookie: sessionCookie }),
    { params: Promise.resolve({ id: storedCredentialId }) },
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(readPasskeys(), []);
});
