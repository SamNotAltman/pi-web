import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPasskeys } from "@/lib/passkey-store";
import { isWebPasswordEnabled } from "@/lib/web-auth";
import {
  PI_WEB_CHALLENGE_MAX_AGE,
  challengeCookieOptions,
  createChallengeToken,
  isWebAuthnSecureContext,
  webAuthnRequestContext,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/** Issue assertion options for the passkeys registered with this relying party. */
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

  const credentials = readPasskeys().filter((passkey) => passkey.rpId === context.rpId);
  if (credentials.length === 0) {
    return NextResponse.json(
      { error: "No passkey registered for this host", hasPasskeys: false },
      { status: 404 },
    );
  }

  const options = await generateAuthenticationOptions({
    rpID: context.rpId,
    allowCredentials: credentials.map((passkey) => ({
      id: passkey.id,
      transports: passkey.transports,
    })),
    userVerification: "preferred",
  });

  const response = NextResponse.json(options);
  response.cookies.set({
    ...challengeCookieOptions(request),
    value: createChallengeToken(password, "authentication", options.challenge),
    maxAge: PI_WEB_CHALLENGE_MAX_AGE,
  });
  return response;
}
