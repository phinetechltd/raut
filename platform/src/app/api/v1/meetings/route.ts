import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { createMeeting, listMeetings } from "@/server/meetings";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "meeting:read" }, async ({ principal, searchParams }) => {
  const s = searchParams.get("scope");
  return listMeetings(principal, { scope: s === "upcoming" || s === "past" ? s : "all" });
});

const schema = z.object({
  title: z.string().min(2),
  customerId: z.string().nullable().optional(),
  scheduledAt: z.string(),
  durationMin: z.number().int().min(5).max(480).optional(),
  notes: z.string().nullable().optional(),
});

export const POST = handler({ permission: "meeting:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const meeting = await createMeeting(principal, input);
  await auditAs(principal, "CREATE", "Meeting", meeting.id, { title: meeting.title, roomName: meeting.roomName }, request);
  return ok(meeting, undefined, { status: 201 });
});
