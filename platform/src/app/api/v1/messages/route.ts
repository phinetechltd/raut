import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { isSelfScoped } from "@/lib/rbac";
import { officeInbox, repThread, sendMessage, unreadCount } from "@/server/messaging";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "message:read" }, async ({ principal, searchParams }) => {
  if (searchParams.get("unread") === "1") return { count: await unreadCount(principal) };
  // A rep gets their own thread; the office gets the inbox of all rep threads.
  if (isSelfScoped(principal)) return repThread(principal);
  return officeInbox(principal);
});

const schema = z.object({ repId: z.string().nullable().optional(), body: z.string().min(1).max(4000) });

export const POST = handler({ permission: "message:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const message = await sendMessage(principal, input);
  await auditAs(principal, "CREATE", "Message", message.id, { conversationId: message.conversationId }, request);
  return ok(message, undefined, { status: 201 });
});
