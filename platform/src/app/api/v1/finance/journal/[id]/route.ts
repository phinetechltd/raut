import { handler, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>({ permission: "report:financial" }, async ({ principal, params }) => {
  const entry = await db.journalEntry.findFirst({
    where: { id: params.id, ...scope(principal) },
    include: { lines: { include: { account: { select: { code: true, name: true, type: true } } } } },
  });
  if (!entry) throw notFound("Journal not found");
  return entry;
});
