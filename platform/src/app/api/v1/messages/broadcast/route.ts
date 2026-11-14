import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { broadcast } from "@/server/messaging";

export const dynamic = "force-dynamic";

const schema = z.object({ body: z.string().min(1).max(4000) });

export const POST = handler({ permission: "message:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const result = await broadcast(principal, input.body);
  await auditAs(principal, "CREATE", "Message", "broadcast", { recipients: result.sent }, request);
  return ok(result, undefined, { status: 201 });
});
