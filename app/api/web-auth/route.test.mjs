import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const originalShowPasswordLogin = process.env.PI_WEB_SHOW_PASSWORD_LOGIN;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-auth-route-"));
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST, DELETE } = await jiti.import("./route.ts");

before(() => {
  process.env.PI_WEB_PASSWORD = "correct horse battery staple";
  delete process.env.PI_WEB_SHOW_PASSWORD_LOGIN;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(() => {
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalShowPasswordLogin === undefined) delete process.env.PI_WEB_SHOW_PASSWORD_LOGIN;
  else process.env.PI_WEB_SHOW_PASSWORD_LOGIN = originalShowPasswordLogin;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function request(method, body, headers = {}) {
  return new NextRequest("http://localhost/api/web-auth", {
    method,
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("does not advertise password authentication to anonymous clients", async () => {
  const response = await GET(request("GET"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    hasPasskeys: false,
    showPasswordLogin: false,
  });
});

test("logs in with one password and reports the signed session", async () => {
  let response = await POST(request("POST", { password: "wrong" }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);

  response = await POST(request("POST", { password: "correct horse battery staple" }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=v1\./);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
  assert.match(cookie, /Path=\//i);
  assert.doesNotMatch(cookie, /Max-Age=/i);

  const cookiePair = cookie.split(";", 1)[0];
  response = await GET(request("GET", undefined, { Cookie: cookiePair }));
  assert.deepEqual(
    await response.json(),
    { hasPasskeys: false, showPasswordLogin: false, enabled: true, authenticated: true },
  );
});

test("remember-me login persists the session cookie", async () => {
  const response = await POST(request("POST", {
    password: "correct horse battery staple",
    rememberMe: true,
  }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=v1\./);
  assert.match(cookie, /Max-Age=2592000/i);
  assert.match(cookie, /Expires=/i);
  assert.match(cookie, /SameSite=lax/i);
});

test("non-boolean rememberMe values do not persist the session cookie", async () => {
  const response = await POST(request("POST", {
    password: "correct horse battery staple",
    rememberMe: "true",
  }));
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers.get("set-cookie"), /Max-Age=/i);
});

test("reports the password fallback button visibility from the environment", async () => {
  process.env.PI_WEB_SHOW_PASSWORD_LOGIN = "1";
  try {
    const response = await GET(request("GET"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).showPasswordLogin, true);
  } finally {
    delete process.env.PI_WEB_SHOW_PASSWORD_LOGIN;
  }
});

test("logout clears the session cookie", async () => {
  const response = await DELETE(request("DELETE"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /pi_web_session=;/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
});

test("rejects cross-origin login attempts", async () => {
  const response = await POST(request(
    "POST",
    { password: "correct horse battery staple" },
    { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
  ));
  assert.equal(response.status, 403);
});

test("rate-limits repeated password failures from the same client", async () => {
  const ip = "203.0.113.77";
  for (let i = 0; i < 10; i += 1) {
    const response = await POST(request("POST", { password: "wrong" }, { "CF-Connecting-IP": ip }));
    assert.equal(response.status, 401);
  }
  const limited = await POST(request("POST", { password: "wrong" }, { "CF-Connecting-IP": ip }));
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get("retry-after") ?? "", /^[1-9]/);
  assert.equal((await limited.json()).error, "Too many login attempts");

  const evenCorrect = await POST(request(
    "POST",
    { password: "correct horse battery staple" },
    { "CF-Connecting-IP": ip },
  ));
  assert.equal(evenCorrect.status, 429);
});
