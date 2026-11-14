import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { sendOneOff } from "@/server/email";

export const dynamic = "force-dynamic";

const schema = z.object({
  customerId: z.string().nullable().optional(),
  toEmail: z.string().email().optional(),
  subject: z.string().min(1),
  html: z.string().min(1),
});

export const POST = handler({ permission: "email:send" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const message = await sendOneOff(principal, input);
  await auditAs(principal, "CREATE", "EmailMessage", message.id, { to: message.toEmail, status: message.status }, request);
  return ok(message, undefined, { status: 201 });
});
