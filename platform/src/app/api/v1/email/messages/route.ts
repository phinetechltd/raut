import { handler } from "@/lib/api";
import { listMessages } from "@/server/email";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "email:read" }, async ({ principal, searchParams }) => {
  return listMessages(principal, {
    campaignId: searchParams.get("campaignId") ?? undefined,
    q: searchParams.get("q") ?? undefined,
  });
});
