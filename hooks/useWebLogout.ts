"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Browser-password logout (`DELETE /api/web-auth`). `enabled` stays false
 * until the status read says the password is on, so a page without it never
 * shows a control. Success replaces the page with `/login`; a failure sets
 * `error` and returns false.
 */
export function useWebLogout(): {
  enabled: boolean;
  loggingOut: boolean;
  error: boolean;
  logOut: () => Promise<boolean>;
} {
  const [enabled, setEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/web-auth")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (!cancelled) setEnabled(data?.enabled === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const logOut = useCallback(async () => {
    setLoggingOut(true);
    setError(false);
    try {
      const response = await fetch("/api/web-auth", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      window.location.replace("/login");
      return true;
    } catch {
      setError(true);
      setLoggingOut(false);
      return false;
    }
  }, []);

  return { enabled, loggingOut, error, logOut };
}
