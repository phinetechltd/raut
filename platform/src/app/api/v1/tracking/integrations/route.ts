import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { companyIdOf, scope } from "@/lib/tenant";
import { issueTrackerKey } from "@/server/trackers";

export const dynamic = "force-dynamic";

/** The key hash never leaves the server, not even to the admin who issued it. */
const PUBLIC_FIELDS = {
  id: true,
  name: true,
  provider: true,
  keyPrefix: true,
  active: true,
  lastUsedAt: true,
  createdAt: true,
  _count: { select: { devices: true } },
} as const;

export const GET = handler({ permission: "tracker:manage" }, async ({ principal }) => {
  return db.trackerIntegration.findMany({
    where: scope(principal),
    select: PUBLIC_FIELDS,
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  provider: z.enum(["GENERIC", "TRACCAR"]).optional(),
});

/** Issues a key. This response is the only time the full key is ever visible. */
export const POST = handler({ permission: "tracker:manage" }, async ({ principal, request }) => {
  const companyId = companyIdOf(principal);
  const input = await parseBody(request, createSchema);
  const { apiKey, keyHash, keyPrefix } = issueTrackerKey();

  const integration = await db.trackerIntegration.create({
    data: {
      companyId,
      name: input.name,
      provider: input.provider ?? "GENERIC",
      keyHash,
      keyPrefix,
      createdById: principal.userId,
    },
    select: PUBLIC_FIELDS,
  });

  await auditAs(principal, "CREATE", "TrackerIntegration", integration.id, { name: input.name, keyPrefix }, request);
  return ok({ ...integration, apiKey }, undefined, { status: 201 });
});
