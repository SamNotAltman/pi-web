"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";

function LogoutIcon({ size, strokeWidth }: { size: number; strokeWidth: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export function WebAuthLogoutButton({ variant }: { variant: "toolbar" | "settings" }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/web-auth")
      .then((response) => response.ok ? response.json() : null)
      .then((data: { enabled?: boolean } | null) => {
        if (data?.enabled === true) setEnabled(true);
      })
      .catch(() => {});
  }, []);

  const logOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setError("");
    try {
      const response = await fetch("/api/web-auth", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      window.location.replace("/login");
    } catch {
      setError(t("auth.logoutFailed"));
      setLoggingOut(false);
    }
  };

  if (!enabled) return null;

  const label = loggingOut ? t("auth.loggingOut") : t("auth.logOut");

  if (variant === "settings") {
    return (
      <section className="settings-general-section">
        <ConfigButton variant="secondary" disabled={loggingOut} onClick={() => void logOut()}>
          <LogoutIcon size={14} strokeWidth={1.8} />
          {label}
        </ConfigButton>
        {error && <p role="alert" className="settings-general-error">{error}</p>}
      </section>
    );
  }

  return (
    <button
      type="button"
      className="web-auth-logout-button"
      disabled={loggingOut}
      onClick={() => void logOut()}
      title={error || t("auth.logOut")}
      aria-label={t("auth.logOut")}
    >
      <LogoutIcon size={12} strokeWidth={2.2} />
      {label}
    </button>
  );
}
