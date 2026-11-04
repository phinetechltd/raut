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
 *
 * One log line per run, and a **502 when everything attempted failed**: a
 * timer that gets a 200 for a sweep in which nothing was filed never alerts
 * anyone, and `curl -f` in the unit file only notices a non-2xx.
 */
export const POST = handler({ public: true }, async ({ request, searchParams }) => {
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

  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") ?? 50) || 50));
  const summary = await runPending(limit);

  const succeeded = summary.invoices + summary.creditNotes + summary.stock + summary.awaiting;
  const allFailed = summary.processed > 0 && succeeded === 0 && summary.failures > 0;

  console.log(
    `[etims] run processed=${summary.processed} invoices=${summary.invoices} creditNotes=${summary.creditNotes} ` +
      `stock=${summary.stock} awaiting=${summary.awaiting} failures=${summary.failures} deferred=${summary.deferred} ` +
      `durationMs=${summary.durationMs}${allFailed ? " ALL_FAILED" : ""}` +
      (summary.errors.length > 0 ? ` firstError=${JSON.stringify(summary.errors[0])}` : ""),
  );

  if (allFailed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "ETIMS_RUN_FAILED",
          message: `Every one of ${summary.processed} documents failed to transmit`,
          details: summary,
        },
      },
      { status: 502 },
    );
  }

  return ok(summary);
});
