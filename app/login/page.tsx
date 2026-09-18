"use client";

import { useEffect, useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import {
  getPasskey,
  isPasskeyCancellation,
  isPasskeySupported,
  type RequestOptionsJSON,
} from "@/lib/webauthn-client";

function safeDestination(): string {
  const destination = new URLSearchParams(window.location.search).get("next");
  return destination?.startsWith("/") && !destination.startsWith("//") ? destination : "/";
}

function PasskeyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 11a2 2 0 0 1 2 2c0 2.5-.5 5-1.2 6.5" />
      <path d="M12 11a2 2 0 0 0-2 2c0 .7.05 1.4.15 2" />
      <path d="M7.4 7.4A6 6 0 0 1 18 12c0 .8-.05 1.6-.15 2.4" />
      <path d="M6 12c0-1.2.35-2.3.95-3.25" />
      <circle cx="12" cy="12" r="9.5" opacity="0" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="2" y1="7" x2="11" y2="7" />
      <polyline points="7.5 3 12 7 7.5 11" />
    </svg>
  );
}

function LoginForm() {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"password" | "passkey">("password");
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [hasPasskeys, setHasPasskeys] = useState(false);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const supported = isPasskeySupported();
    setPasskeySupported(supported);
    void fetch("/api/web-auth")
      .then((response) => response.ok ? response.json() : null)
      .then((data: { hasPasskeys?: boolean; showPasswordLogin?: boolean } | null) => {
        if (data?.showPasswordLogin === true) setShowPasswordLogin(true);
        if (data?.hasPasskeys === true) {
          setHasPasskeys(true);
          if (supported) setMode("passkey");
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rememberMe = new FormData(event.currentTarget).get("rememberMe") === "true";
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/web-auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, rememberMe }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? t("auth.invalidPassword") : t("auth.loginFailed"));
        return;
      }
      window.location.replace(safeDestination());
    } catch {
      setError(t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  const loginWithPasskey = async () => {
    setBusy(true);
    setError("");
    try {
      const optionsResponse = await fetch("/api/web-auth/passkey/login/options", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!optionsResponse.ok) {
        setError(t("auth.passkeyFailed"));
        return;
      }
      const options = await optionsResponse.json() as RequestOptionsJSON;
      const credential = await getPasskey(options);
      const verifyResponse = await fetch("/api/web-auth/passkey/login/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: credential }),
      });
      if (!verifyResponse.ok) {
        setError(t("auth.passkeyFailed"));
        return;
      }
      window.location.replace(safeDestination());
    } catch (caught) {
      if (!isPasskeyCancellation(caught)) setError(t("auth.passkeyFailed"));
    } finally {
      setBusy(false);
    }
  };

  const showPasskeyMode = passkeySupported && hasPasskeys && mode === "passkey";

  return (
    <main className="web-login-page">
      <div className="web-login-shell">
        <header className="web-login-brand">
          <img src="/icons/pi-180.png" width={52} height={52} alt="" />
          <div>
            <h1>Pi Web</h1>
            <p>{t("auth.prompt")}</p>
          </div>
        </header>

        {!loaded ? (
          <div className="web-login-form" aria-busy="true">
            <div className="web-login-composer web-login-composer-pending" />
          </div>
        ) : showPasskeyMode ? (
          <div className="web-login-form">
            <div className="web-login-composer">
              <button type="button" className="web-login-passkey-button" onClick={() => void loginWithPasskey()} disabled={busy}>
                <PasskeyIcon />
                {busy ? t("auth.verifyingPasskey") : t("auth.signInWithPasskey")}
              </button>
            </div>
            {showPasswordLogin && (
              <button
                type="button"
                className="web-login-alt"
                onClick={() => { setMode("password"); setError(""); }}
                disabled={busy}
              >
                {t("auth.usePassword")}
              </button>
            )}
            <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
          </div>
        ) : (
          <form className="web-login-form" onSubmit={submit}>
            <div className="web-login-composer">
              <label className="web-login-label" htmlFor="web-login-password">{t("auth.password")}</label>
              <input
                id="web-login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("auth.password")}
                autoComplete="current-password"
                autoFocus
                required
                disabled={busy}
              />
              <button type="submit" disabled={busy || !password}>
                <ArrowIcon />
                {busy ? t("auth.loggingIn") : t("auth.logIn")}
              </button>
            </div>
            <label className="web-login-remember">
              <input id="web-login-remember" type="checkbox" name="rememberMe" value="true" />
              {t("auth.rememberMe")}
            </label>
            {loaded && passkeySupported && hasPasskeys && (
              <button
                type="button"
                className="web-login-alt"
                onClick={() => { setMode("passkey"); setError(""); }}
                disabled={busy}
              >
                {t("auth.usePasskey")}
              </button>
            )}
            {loaded && !hasPasskeys && (
              <p className="web-login-hint">{t("auth.setupPasskeyHint")}</p>
            )}
            <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
          </form>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <I18nProvider><LoginForm /></I18nProvider>;
}
