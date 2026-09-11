import { NextRequest, NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createWebSessionToken,
  isValidWebPassword,
  isValidWebSessionToken,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

function sessionCookieOptions(request: Request) {
  return {
    name: PI_WEB_SESSION_COOKIE,
    httpOnly: true as const,
    // Lax is sent on top-level navigations after a browser restart, bookmark,
    // or dock/home-screen launch. Strict is omitted in those cases and looks
    // like Remember me failed. API CSRF is enforced separately by Origin checks.
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
  };
}

function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    ...sessionCookieOptions(request),
    value: "",
    maxAge: 0,
  });
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  const enabled = isWebPasswordEnabled(password);
  const authenticated = !enabled
    || isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password);
  return NextResponse.json(
    { enabled, authenticated },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    return NextResponse.json({ error: "Password authentication is disabled" }, { status: 404 });
  }

  const body = await request.json().catch(() => null) as { password?: unknown; rememberMe?: unknown } | null;
  if (!body || typeof body.password !== "string" || !isValidWebPassword(body.password, password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const rememberMe = body.rememberMe === true;
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    ...sessionCookieOptions(request),
    value: createWebSessionToken(password),
    ...(rememberMe
      ? {
        maxAge: PI_WEB_SESSION_MAX_AGE,
        expires: new Date(Date.now() + PI_WEB_SESSION_MAX_AGE * 1000),
      }
      : {}),
  });
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response, request);
  return response;
}
