import { NextResponse } from "next/server";

import { handler, ok } from "@/lib/api";
import { reconcileIntents } from "@/server/collections";

export const dynamic = "force-dynamic";

/**
 * Reconciles open collections, for the systemd timer (`deploy/raut-payments.timer`).
 *
 * Authenticated by a shared token rather than a session, because the caller is
 * a timer with no user — the same pattern as `/etims/run`. It is `public` only
 * in the routing sense: with no `PAYMENTS_RUNNER_TOKEN` set it refuses every
 * call, because an open endpoint that fires verify calls at Safaricom and
 * Paystack is a free way to burn the company's rate limit.
 *
 * One log line per run. A **502 when every re-check errored** — a timer that
 * gets 200 for a sweep in which the provider was unreachable throughout never
 * alerts anyone, and `curl -f` in the unit file only notices a non-2xx.
 */
export const POST = handler({ public: true }, async ({ request, searchParams }) => {
  const expected = process.env.PAYMENTS_RUNNER_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_CONFIGURED", message: "No PAYMENTS_RUNNER_TOKEN is set" } },
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

  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") ?? 200) || 200));
  const summary = await reconcileIntents({ limit });

  const allFailed = summary.errors.length > 0 && summary.rechecked === 0;

  console.log(
    `[payments] reconcile expired=${summary.expired} orphansKeyed=${summary.orphansKeyed} rechecked=${summary.rechecked} ` +
      `settled=${summary.settled} failed=${summary.failed} staleClaims=${summary.staleClaims} errors=${summary.errors.length} ` +
      `durationMs=${summary.durationMs}${allFailed ? " ALL_FAILED" : ""}` +
      (summary.errors.length > 0 ? ` firstError=${JSON.stringify(summary.errors[0])}` : ""),
  );

  if (allFailed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "RECONCILE_FAILED",
          message: `Every one of ${summary.errors.length} re-checks failed`,
          details: summary,
        },
      },
      { status: 502 },
    );
  }

  return ok(summary);
});
