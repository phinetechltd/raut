import { ok } from "@/lib/api";
import { clearSessionCookie, getPrincipal, revokeRefreshToken } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const principal = await getPrincipal(request);

  const body = await request
    .json()
    .catch(() => ({}) as { refreshToken?: string });

  if (body?.refreshToken) await revokeRefreshToken(body.refreshToken);
  await clearSessionCookie();

  if (principal) {
    await audit({
      companyId: principal.companyId,
      userId: principal.userId,
      action: "LOGOUT",
      entity: "User",
      entityId: principal.userId,
      request,
    });
  }

  return ok({ signedOut: true });
}
