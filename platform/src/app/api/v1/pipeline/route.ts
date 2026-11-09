import { handler } from "@/lib/api";
import { companyIdOf } from "@/lib/tenant";
import { ensureStages } from "@/server/crm";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "deal:read" }, async ({ principal }) => {
  return ensureStages(companyIdOf(principal));
});
