import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { updateMeeting } from "@/server/meetings";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().min(2).optional(),
  customerId: z.string().nullable().optional(),
  scheduledAt: z.string().optional(),
  durationMin: z.number().int().min(5).max(480).optional(),
  notes: z.string().nullable().optional(),
  status: z.enum(["SCHEDULED", "DONE", "CANCELLED"]).optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "meeting:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const meeting = await updateMeeting(principal, params.id, input);
  await auditAs(principal, "UPDATE", "Meeting", meeting.id, input as Record<string, unknown>, request);
  return meeting;
});
