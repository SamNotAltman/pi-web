import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * A WebAuthn credential registered for this Pi Web instance. `publicKey` is the
 * raw COSE key returned by the authenticator (base64url); pass-key material
 * never leaves the authenticator, so this file only holds public values.
 */
export interface StoredPasskey {
  /** Base64url credential ID, the lookup key for authentication. */
  id: string;
  /** Base64url COSE public key used to verify assertions. */
  publicKey: string;
  /** Relying party the credential was registered for. */
  rpId: string;
  /** Signature counter reported by the last successful authentication. */
  counter: number;
  /** Human-readable label shown in the settings list. */
  name: string;
  createdAt: number;
  lastUsedAt?: number;
  transports?: string[];
}

export const PASSKEY_STORE_VERSION = 1;

export function getPasskeyStorePath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-passkeys.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredPasskey(value: unknown): value is StoredPasskey {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.length > 0
    && typeof value.publicKey === "string" && value.publicKey.length > 0
    && typeof value.rpId === "string"
    && typeof value.counter === "number" && Number.isFinite(value.counter)
    && typeof value.name === "string"
    && typeof value.createdAt === "number" && Number.isFinite(value.createdAt);
}

/**
 * Read every registered passkey. A missing or unreadable store degrades to "no
 * passkeys" so a damaged file can never lock the password fallback out; the
 * caller decides whether that is a failure.
 */
export function readPasskeys(path = getPasskeyStorePath()): StoredPasskey[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.warn(`[pi-web] Ignoring unreadable passkey store at ${path}`);
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.credentials)) return [];
  return parsed.credentials.filter(isStoredPasskey);
}

function writePasskeys(credentials: StoredPasskey[], path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({
    version: PASSKEY_STORE_VERSION,
    credentials,
  }, null, 2));
}

export function findPasskey(id: string, path = getPasskeyStorePath()): StoredPasskey | undefined {
  return readPasskeys(path).find((passkey) => passkey.id === id);
}

/** Insert or replace a credential. Returns the stored list. */
export function addPasskey(
  passkey: StoredPasskey,
  path = getPasskeyStorePath(),
): StoredPasskey[] {
  const credentials = readPasskeys(path).filter((existing) => existing.id !== passkey.id);
  credentials.push(passkey);
  writePasskeys(credentials, path);
  return credentials;
}

export function removePasskey(id: string, path = getPasskeyStorePath()): boolean {
  const credentials = readPasskeys(path);
  const remaining = credentials.filter((passkey) => passkey.id !== id);
  if (remaining.length === credentials.length) return false;
  writePasskeys(remaining, path);
  return true;
}

/** Record a successful assertion so the list can show recent activity. */
export function recordPasskeyUse(
  id: string,
  counter: number,
  lastUsedAt = Date.now(),
  path = getPasskeyStorePath(),
): void {
  const credentials = readPasskeys(path);
  const passkey = credentials.find((existing) => existing.id === id);
  if (!passkey) return;
  passkey.counter = counter;
  passkey.lastUsedAt = lastUsedAt;
  writePasskeys(credentials, path);
}
