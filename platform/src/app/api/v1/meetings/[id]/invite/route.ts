import { handler, ok } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { inviteCustomer } from "@/server/meetings";

export const dynamic = "force-dynamic";

export const POST = handler<{ id: string }>({ permission: "meeting:write" }, async ({ principal, params, request }) => {
  const message = await inviteCustomer(principal, params.id);
  await auditAs(principal, "CREATE", "EmailMessage", message.id, { meetingId: params.id, status: message.status }, request);
  return ok({ status: message.status, to: message.toEmail }, undefined, { status: 201 });
});
