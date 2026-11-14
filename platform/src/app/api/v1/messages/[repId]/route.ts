import { handler } from "@/lib/api";
import { officeConversation } from "@/server/messaging";

export const dynamic = "force-dynamic";

/** The office's view of one rep's thread (also marks it read for the office). */
export const GET = handler<{ repId: string }>({ permission: "message:read" }, async ({ principal, params }) => {
  return officeConversation(principal, params.repId);
});
