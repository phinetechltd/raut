import { NextResponse } from "next/server";

import { ApiError, handler, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { MAX_FIXES_PER_REQUEST, normalisePayload, trackerKeyFrom } from "@/lib/tracker-ingest";
import { authenticateTracker, ingestFixes, type TrackerCaller } from "@/server/trackers";

export const dynamic = "force-dynamic";

/** Around 2 MB holds a full batch of the most verbose position we accept. */
const MAX_BODY_BYTES = 2_000_000;
/** Generous for a whole fleet behind one key, and still stops a runaway loop. */
const MAX_REQUESTS_PER_MINUTE = 600;

const windows = new Map<string, { startedAt: number; count: number }>();

function allow(integrationId: string, now = Date.now()): boolean {
  const entry = windows.get(integrationId);
  if (!entry || now - entry.startedAt >= 60_000) {
    windows.set(integrationId, { startedAt: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_REQUESTS_PER_MINUTE;
}

async function callerFrom(request: Request): Promise<TrackerCaller> {
  const apiKey = trackerKeyFrom(request.headers);
  if (!apiKey) {
    throw new ApiError(
      401,
      "API_KEY_REQUIRED",
      "Send the key from Settings → Vehicle trackers as an X-Api-Key or Authorization: Bearer header",
    );
  }
  return authenticateTracker(apiKey);
}

/**
 * Tracker position intake.
 *
 * Authenticated by a company API key, not a user session; the company comes from
 * the key. Responds 200 with counts even when individual fixes were refused,
 * because the sender can only retry the whole request and retrying a bad fix
 * will not improve it. A 4xx means nothing was stored and something about the
 * request as a whole has to change.
 */
export const POST = handler({ public: true }, async ({ request }) => {
  const caller = await callerFrom(request);

  if (!allow(caller.id)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests for this key; slow down" } },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  }

  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Send at most ${MAX_FIXES_PER_REQUEST} positions per request`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Request body must be valid JSON");
  }

  const { fixes, rejected, tooMany, unreadable } = normalisePayload(body);
  if (unreadable) throw new ApiError(400, "BAD_REQUEST", "Expected a position, a list of positions, or { positions: [...] }");
  if (tooMany) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Send at most ${MAX_FIXES_PER_REQUEST} positions per request`);

  const result = await ingestFixes(caller, fixes);
  return ok({
    received: fixes.length + rejected.length,
    ...result,
    rejected: rejected.length,
    // Enough to fix the sender, capped so a broken unit cannot make replies huge.
    rejections: rejected.slice(0, 20),
  });
});

/** Connection test: proves a key works before any tracker is pointed at it. */
export const GET = handler({ public: true }, async ({ request }) => {
  const caller = await callerFrom(request);
  const [devices, assigned, company] = await Promise.all([
    db.trackerDevice.count({ where: { companyId: caller.companyId } }),
    db.trackerDevice.count({ where: { companyId: caller.companyId, vehicleId: { not: null } } }),
    db.company.findUniqueOrThrow({ where: { id: caller.companyId }, select: { name: true } }),
  ]);
  return ok({ connected: true, integration: caller.name, company: company.name, devices, assigned });
});
