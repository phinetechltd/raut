import { z } from "zod";

import { fail, ok, parseBody } from "@/lib/api";
import {
  ACCESS_TTL_MIN,
  claimsForUser,
  rotateRefreshToken,
  signAccessToken,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

const schema = z.object({ refreshToken: z.string().min(16) });

/**
 * Rotates the mobile session. The old refresh token is revoked as part of the
 * exchange, so a token captured off the wire stops working the moment the real
 * device refreshes.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, schema).catch(() => null);
  if (!body) return fail(422, "VALIDATION_FAILED", "refreshToken is required");

  const rotated = await rotateRefreshToken(body.refreshToken);
  if (!rotated) {
    return fail(401, "REFRESH_INVALID", "Session expired. Please sign in again.");
  }

  const claims = await claimsForUser(rotated.userId);
  if (!claims) {
    return fail(401, "REFRESH_INVALID", "Session expired. Please sign in again.");
  }

  return ok({
    accessToken: await signAccessToken(claims),
    refreshToken: rotated.refreshToken,
    expiresIn: ACCESS_TTL_MIN * 60,
  });
}
