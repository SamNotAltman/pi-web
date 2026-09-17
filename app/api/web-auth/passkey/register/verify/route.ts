import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { addPasskey } from "@/lib/passkey-store";
import { isWebPasswordEnabled } from "@/lib/web-auth";
import {
  PI_WEB_CHALLENGE_COOKIE,
  challengeCookieOptions,
  defaultPasskeyName,
  isValidRegistrationResponse,
  isWebAuthnSecureContext,
  readChallengeToken,
  webAuthnRequestContext,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/**
 * Complete registration. The signed challenge cookie is the capability issued
 * by the options route, so no session is required here.
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
  if (!context || !isWebAuthnSecureContext(context)) {
    return NextResponse.json({ error: "Invalid request host" }, { status: 400 });
  }

  const challenge = readChallengeToken(
    request.cookies.get(PI_WEB_CHALLENGE_COOKIE)?.value,
    password,
    "registration",
  );
  if (!challenge) {
    return NextResponse.json({ error: "Registration challenge expired" }, { status: 400 });
  }

  const body = await request.json().catch(() => null) as { response?: unknown; name?: unknown } | null;
  if (!body || !isValidRegistrationResponse(body.response)) {
    return NextResponse.json({ error: "Invalid registration response" }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: context.origin,
      expectedRPID: context.rpId,
      // Options request "preferred" UV, so a security key that only proves
      // user presence must still be accepted here.
      requireUserVerification: false,
    });
  } catch {
    return NextResponse.json({ error: "Passkey verification failed" }, { status: 400 });
  }
  if (!verification.verified) {
    return NextResponse.json({ error: "Passkey verification failed" }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;
  const name = typeof body.name === "string" && body.name.trim().length > 0
    ? body.name.trim().slice(0, 64)
    : defaultPasskeyName(request.headers.get("user-agent"));

  addPasskey({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    rpId: context.rpId,
    counter: credential.counter,
    name,
    createdAt: Date.now(),
    transports: credential.transports,
  });

  const response = NextResponse.json({ ok: true });
  response.cookies.set({ ...challengeCookieOptions(request), value: "", maxAge: 0 });
  return response;
}
