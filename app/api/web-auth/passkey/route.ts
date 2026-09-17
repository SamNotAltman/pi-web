import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readPasskeys } from "@/lib/passkey-store";
import {
  PI_WEB_SESSION_COOKIE,
  isValidWebSessionToken,
  isWebPasswordEnabled,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

/** List registered passkeys for the settings UI. Requires a web session. */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    return NextResponse.json({ error: "Authentication is disabled" }, { status: 404 });
  }

  const authenticated = isValidWebSessionToken(
    request.cookies.get(PI_WEB_SESSION_COOKIE)?.value,
    password,
  );
  if (!authenticated) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const passkeys = readPasskeys().map(({ id, name, createdAt, lastUsedAt }) => ({
    id,
    name,
    createdAt,
    lastUsedAt,
  }));
  return NextResponse.json({ passkeys }, { headers: { "Cache-Control": "no-store" } });
}
