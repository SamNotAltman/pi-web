import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useWebLogout } = await jiti.import("./useWebLogout.ts");

const answers = [];
globalThis.fetch = async (url, init = {}) => {
  const answer = answers.shift();
  if (!answer) throw new Error(`no answer scripted for ${init.method ?? "GET"} ${url}`);
  return answer(url, init);
};

const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function settle(hook) {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
  hook.flush();
}

const mounted = [];
test.afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount();
  assert.equal(answers.length, 0, "every scripted answer was used");
});

test("the control stays hidden until the status read says the password is on", async () => {
  answers.push(json(200, { enabled: false }));
  const hook = renderHook(() => useWebLogout());
  mounted.push(hook);
  assert.equal(hook.result.enabled, false);
  await settle(hook);
  assert.equal(hook.result.enabled, false);

  answers.push(json(200, { enabled: true }));
  const on = renderHook(() => useWebLogout());
  mounted.push(on);
  await settle(on);
  assert.equal(on.result.enabled, true);
  assert.equal(on.result.error, false);
});

test("a failed status read leaves the control hidden", async () => {
  answers.push(() => Promise.reject(new TypeError("fetch failed")));
  const hook = renderHook(() => useWebLogout());
  mounted.push(hook);
  await settle(hook);
  assert.equal(hook.result.enabled, false);
});

test("logout replaces the page, and a failure is reported without navigating", async () => {
  answers.push(json(200, { enabled: true }));
  const hook = renderHook(() => useWebLogout());
  mounted.push(hook);
  await settle(hook);

  const replaced = [];
  const previous = globalThis.window;
  globalThis.window = { location: { replace: (url) => replaced.push(url) } };
  try {
    answers.push(json(500, { error: "no" }));
    assert.equal(await hook.result.logOut(), false);
    hook.flush();
    assert.equal(hook.result.error, true);
    assert.equal(hook.result.loggingOut, false);
    assert.deepEqual(replaced, []);

    answers.push(json(200, { ok: true }));
    const pending = hook.result.logOut();
    hook.flush();
    assert.equal(hook.result.loggingOut, true);
    assert.equal(await pending, true);
    assert.deepEqual(replaced, ["/login"]);
  } finally {
    globalThis.window = previous;
  }
});
