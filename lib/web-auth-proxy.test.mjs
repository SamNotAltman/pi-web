import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy, config } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
after(() => {
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("rejects Basic Auth and does not challenge the browser", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  const apiResponse = proxy(request("/api/sessions", { Authorization: authorization }));
  const pageResponse = proxy(request("/", { Authorization: authorization }));
  assert.equal(apiResponse.status, 401);
  assert.equal(apiResponse.headers.get("www-authenticate"), null);
  assert.equal(pageResponse.status, 307);
  assert.equal(pageResponse.headers.get("location"), "http://localhost/login");
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
  assert.equal(proxy(request("/api/web-auth/passkey/login/options")).status, 200);
  assert.equal(proxy(request("/api/web-auth/passkey/register/verify")).status, 200);
});

test("redirects unauthenticated pages that are not the login screen", () => {
  const response = proxy(request("/settings"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login");
});

test("matches every page except static assets", () => {
  assert.deepEqual(config.matcher, [
    "/",
    "/((?!_next/|favicon.ico|icons/|offline.html|provider-icons.svg|sw.js|manifest.webmanifest).*)",
  ]);
});
