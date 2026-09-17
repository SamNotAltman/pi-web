import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { findPasskey, recordPasskeyUse } from "@/lib/passkey-store";
import {
  PI_WEB_SESSION_MAX_AGE,
  createWebSessionToken,
  isWebPasswordEnabled,
  webSessionCookieOptions,
} from "@/lib/web-auth";
import {
  PI_WEB_CHALLENGE_COOKIE,
  challengeCookieOptions,
  isValidAuthenticationResponse,
  isWebAuthnSecureContext,
  readChallengeToken,
  webAuthnRequestContext,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/** Verify an assertion and, on success, issue the same session cookie as the password flow. */
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
  if (!context || !isWebAuthnSecureContext(context)) {
    return NextResponse.json({ error: "Invalid request host" }, { status: 400 });
  }

  const challenge = readChallengeToken(
    request.cookies.get(PI_WEB_CHALLENGE_COOKIE)?.value,
    password,
    "authentication",
  );
  if (!challenge) {
    return NextResponse.json({ error: "Authentication challenge expired" }, { status: 400 });
  }

  const body = await request.json().catch(() => null) as { response?: unknown; rememberMe?: unknown } | null;
  if (!body || !isValidAuthenticationResponse(body.response)) {
    return NextResponse.json({ error: "Invalid authentication response" }, { status: 400 });
  }

  const passkey = findPasskey(body.response.id);
  if (!passkey || passkey.rpId !== context.rpId) {
    return NextResponse.json({ error: "Unknown passkey" }, { status: 401 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: context.origin,
      expectedRPID: context.rpId,
      credential: {
        id: passkey.id,
        publicKey: Buffer.from(passkey.publicKey, "base64url"),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: false,
    });
  } catch {
    return NextResponse.json({ error: "Passkey verification failed" }, { status: 401 });
  }
  if (!verification.verified) {
    return NextResponse.json({ error: "Passkey verification failed" }, { status: 401 });
  }

  recordPasskeyUse(passkey.id, verification.authenticationInfo.newCounter);

  // Passkeys are the long-lived credential, so the session persists by default.
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    ...webSessionCookieOptions(request),
    value: createWebSessionToken(password),
    ...(body.rememberMe === false
      ? {}
      : {
        maxAge: PI_WEB_SESSION_MAX_AGE,
        expires: new Date(Date.now() + PI_WEB_SESSION_MAX_AGE * 1000),
      }),
  });
  response.cookies.set({ ...challengeCookieOptions(request), value: "", maxAge: 0 });
  return response;
}
