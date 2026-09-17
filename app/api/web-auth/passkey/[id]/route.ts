import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { removePasskey } from "@/lib/passkey-store";
import {
  PI_WEB_SESSION_COOKIE,
  isValidWebSessionToken,
  isWebPasswordEnabled,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Delete one passkey. Requires a web session. */
export async function DELETE(request: NextRequest, { params }: Params) {
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

  const { id } = await params;
  return removePasskey(id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Passkey not found" }, { status: 404 });
}
