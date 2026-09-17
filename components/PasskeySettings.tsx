"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import {
  createPasskey,
  isPasskeyCancellation,
  isPasskeySupported,
  type RegistrationOptionsJSON,
} from "@/lib/webauthn-client";

interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
}

export function PasskeySettings() {
  const { t, locale } = useI18n();
  const [visible, setVisible] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/web-auth/passkey");
      if (response.status === 401 || response.status === 404) {
        setVisible(false);
        return;
      }
      if (!response.ok) {
        setVisible(true);
        setError(t("settings.passkeysLoadFailed"));
        return;
      }
      const data = await response.json() as { passkeys?: PasskeyInfo[] };
      setVisible(true);
      setPasskeys(Array.isArray(data.passkeys) ? data.passkeys : []);
    } catch {
      setVisible(true);
      setError(t("settings.passkeysLoadFailed"));
    }
  }, [t]);

  useEffect(() => {
    setSupported(isPasskeySupported());
    void load();
  }, [load]);

  const addPasskey = async () => {
    setBusy(true);
    setError("");
    try {
      const optionsResponse = await fetch("/api/web-auth/passkey/register/options", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!optionsResponse.ok) {
        setError(t("settings.passkeysAddFailed"));
        return;
      }
      const options = await optionsResponse.json() as RegistrationOptionsJSON;
      const credential = await createPasskey(options);
      const verifyResponse = await fetch("/api/web-auth/passkey/register/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: credential }),
      });
      if (!verifyResponse.ok) {
        setError(t("settings.passkeysAddFailed"));
        return;
      }
      await load();
    } catch (caught) {
      if (!isPasskeyCancellation(caught)) setError(t("settings.passkeysAddFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/web-auth/passkey/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        setError(t("settings.passkeysRemoveFailed"));
        return;
      }
      await load();
    } catch {
      setError(t("settings.passkeysRemoveFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.passkeys")}</h3>
      <p className="settings-general-description">{t("settings.passkeysDescription")}</p>
      {passkeys.length === 0 ? (
        <p className="settings-general-description">{t("settings.passkeysEmpty")}</p>
      ) : (
        <ul className="settings-passkey-list">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="settings-passkey-row">
              <span className="settings-passkey-name">{passkey.name}</span>
              <span className="settings-passkey-meta">
                {new Date(passkey.createdAt).toLocaleDateString(locale)}
              </span>
              <ConfigButton variant="danger" disabled={busy} onClick={() => void remove(passkey.id)}>
                {t("settings.passkeysRemove")}
              </ConfigButton>
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <ConfigButton variant="secondary" disabled={busy} onClick={() => void addPasskey()}>
          {busy ? t("settings.passkeysAdding") : t("settings.passkeysAdd")}
        </ConfigButton>
      ) : (
        <p className="settings-general-description">{t("settings.passkeysUnsupported")}</p>
      )}
      {error && <p role="alert" className="settings-general-error">{error}</p>}
    </section>
  );
}
