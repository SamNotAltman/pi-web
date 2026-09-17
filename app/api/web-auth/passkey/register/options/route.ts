import { NextRequest, NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPasskeys } from "@/lib/passkey-store";
import {
  PI_WEB_AUTH_USERNAME,
  PI_WEB_SESSION_COOKIE,
  isValidWebPassword,
  isValidWebSessionToken,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import {
  PI_WEB_CHALLENGE_MAX_AGE,
  challengeCookieOptions,
  createChallengeToken,
  isWebAuthnSecureContext,
  webAuthnRequestContext,
  webAuthnUserId,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/**
 * Issue registration options. Authorized by the password (first passkey, from
 * the login page) or by an existing session (adding another device later).
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    return NextResponse.json({ error: "Authentication is disabled" }, { status: 404 });
  }

  const context = webAuthnRequestContext(request);
  if (!context) {
    return NextResponse.json({ error: "Invalid request host" }, { status: 400 });
  }
  if (!isWebAuthnSecureContext(context)) {
    return NextResponse.json({ error: "Passkeys require HTTPS or localhost" }, { status: 400 });
  }

  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const sessionAuthorized = isValidWebSessionToken(
    request.cookies.get(PI_WEB_SESSION_COOKIE)?.value,
    password,
  );
  const passwordAuthorized = typeof body?.password === "string"
    && isValidWebPassword(body.password, password);
  if (!sessionAuthorized && !passwordAuthorized) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const options = await generateRegistrationOptions({
    rpName: "Pi Web",
    rpID: context.rpId,
    userID: webAuthnUserId(context.rpId),
    userName: PI_WEB_AUTH_USERNAME,
    userDisplayName: "Pi Web",
    excludeCredentials: readPasskeys()
      .filter((passkey) => passkey.rpId === context.rpId)
      .map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });

  const response = NextResponse.json(options);
  response.cookies.set({
    ...challengeCookieOptions(request),
    value: createChallengeToken(password, "registration", options.challenge),
    maxAge: PI_WEB_CHALLENGE_MAX_AGE,
  });
  return response;
}
