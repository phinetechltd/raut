import { NextResponse } from "next/server";

import { handler, ok } from "@/lib/api";
import { runPending } from "@/server/etims";

export const dynamic = "force-dynamic";

/**
 * Drains the outstanding queue, for the systemd timer.
 *
 * Authenticated by a shared token rather than a session, because the caller is
 * a timer with no user. It is deliberately not `public: true` in spirit — an
 * unauthenticated endpoint that triggers outbound filing to KRA would be a
 * free denial-of-service against the company's rate limit.
 *
 * The sweep resolves credentials per company inside `runPending`; this endpoint
 * carries no tenant of its own.
 */
export const POST = handler({ public: true }, async ({ request }) => {
  const expected = process.env.ETIMS_RUNNER_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_CONFIGURED", message: "No ETIMS_RUNNER_TOKEN is set" } },
      { status: 503 },
    );
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expected) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHENTICATED", message: "Bad runner token" } },
      { status: 401 },
    );
  }

  return ok(await runPending());
});
