import { NextRequest, NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPasskeys } from "@/lib/passkey-store";
import {
  clearLoginFailures,
  clientIpFromRequest,
  isLoginAttemptLimited,
  loginRateLimitResponseInit,
  recordLoginFailure,
} from "@/lib/login-rate-limit";
import {
  createWebSessionToken,
  isValidWebPassword,
  isValidWebSessionToken,
  isPasswordLoginVisible,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
  webSessionCookieOptions,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    ...webSessionCookieOptions(request),
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
    {
      hasPasskeys: readPasskeys().length > 0,
      showPasswordLogin: isPasswordLoginVisible(),
      ...(authenticated ? { enabled, authenticated: true } : {}),
    },
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

  const ip = clientIpFromRequest(request);
  const limited = isLoginAttemptLimited(ip);
  if (limited.limited) {
    return NextResponse.json({ error: "Too many login attempts" }, loginRateLimitResponseInit(limited.retryAfterSec));
  }

  const body = await request.json().catch(() => null) as { password?: unknown; rememberMe?: unknown } | null;
  if (!body || typeof body.password !== "string" || !isValidWebPassword(body.password, password)) {
    recordLoginFailure(ip);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  clearLoginFailures(ip);

  const rememberMe = body.rememberMe === true;
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    ...webSessionCookieOptions(request),
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
