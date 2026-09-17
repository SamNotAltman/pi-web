import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-passkey-store-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  addPasskey,
  findPasskey,
  getPasskeyStorePath,
  readPasskeys,
  recordPasskeyUse,
  removePasskey,
} = await jiti.import("./passkey-store.ts");

const storePath = getPasskeyStorePath();

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function passkey(id, overrides = {}) {
  return {
    id,
    publicKey: "AAECAw",
    rpId: "localhost",
    counter: 0,
    name: `Passkey ${id}`,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

before(() => {
  rmSync(storePath, { force: true });
});

test("starts empty and stores passkeys", () => {
  assert.deepEqual(readPasskeys(), []);
  addPasskey(passkey("one"));
  addPasskey(passkey("two"));
  assert.deepEqual(readPasskeys().map((entry) => entry.id), ["one", "two"]);
  assert.equal(findPasskey("two")?.name, "Passkey two");
  assert.equal(findPasskey("missing"), undefined);
});

test("replaces a re-registered credential instead of duplicating it", () => {
  addPasskey(passkey("one", { name: "Renamed", counter: 7 }));
  const stored = readPasskeys();
  assert.equal(stored.length, 2);
  assert.equal(findPasskey("one")?.name, "Renamed");
  assert.equal(findPasskey("one")?.counter, 7);
});

test("records counter and last use", () => {
  recordPasskeyUse("two", 42, 1_800_000_000_000);
  assert.equal(findPasskey("two")?.counter, 42);
  assert.equal(findPasskey("two")?.lastUsedAt, 1_800_000_000_000);
});

test("removes passkeys and reports missing ids", () => {
  assert.equal(removePasskey("one"), true);
  assert.equal(removePasskey("one"), false);
  assert.deepEqual(readPasskeys().map((entry) => entry.id), ["two"]);
});

test("degrades to no passkeys when the store is unreadable", () => {
  writeFileSync(storePath, "{not json", "utf8");
  assert.deepEqual(readPasskeys(), []);
});

test("ignores entries that are missing required fields", () => {
  writeFileSync(storePath, JSON.stringify({
    version: 1,
    credentials: [passkey("valid"), { id: "broken" }],
  }), "utf8");
  assert.deepEqual(readPasskeys().map((entry) => entry.id), ["valid"]);
});
