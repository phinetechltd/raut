import { z } from "zod";

import { badRequest, handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { endOfNairobiDay, momentForDay, startOfNairobiDay } from "@/lib/report-engine";
import { companyIdOf, scope } from "@/lib/tenant";
import { createManualJournal } from "@/server/accounting";

export const dynamic = "force-dynamic";

/** `?source=MANUAL`, `?q=` on number or narration, `?from=&to=` as Nairobi days. */
export const GET = handler({ permission: "report:financial" }, async ({ principal, searchParams }) => {
  const page = pagination(searchParams);
  const q = searchParams.get("q")?.trim();
  const source = searchParams.get("source");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const where = {
    ...scope(principal),
    ...(source ? { sourceKind: source } : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { memo: { contains: q } }] } : {}),
    ...(from || to
      ? {
          date: {
            ...(from ? { gte: startOfNairobiDay(from) ?? undefined } : {}),
            ...(to ? { lte: endOfNairobiDay(to) ?? undefined } : {}),
          },
        }
      : {}),
  };
  const [entries, total] = await Promise.all([
    db.journalEntry.findMany({
      where,
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
      orderBy: [{ date: "desc" }, { number: "desc" }],
      take: page.take,
      skip: page.skip,
    }),
    db.journalEntry.count({ where }),
  ]);
  return ok(entries, paginationMeta(page, total));
});

const schema = z.object({
  /** A Nairobi calendar day, YYYY-MM-DD. */
  date: z.string(),
  memo: z.string().trim().min(3).max(200),
  clientUuid: z.string().trim().min(8).max(64).nullish(),
  lines: z
    .array(
      z.object({
        accountId: z.string().min(1),
        debitCents: z.number().int().nonnegative().default(0),
        creditCents: z.number().int().nonnegative().default(0),
        memo: z.string().trim().max(120).nullish(),
      }),
    )
    .min(2)
    .max(100),
});

export const POST = handler({ permission: "journal:write" }, async ({ principal, request }) => {
  const companyId = companyIdOf(principal);
  const input = await parseBody(request, schema);

  const date = momentForDay(input.date);
  if (!date) throw badRequest("date must be a real calendar day, as YYYY-MM-DD");
  if (date.getTime() > Date.now() + 86_400_000) throw badRequest("A journal cannot be dated in the future");

  const entry = await createManualJournal(companyId, principal.userId, {
    date,
    memo: input.memo,
    clientUuid: input.clientUuid,
    lines: input.lines.map((l) => ({
      accountId: l.accountId,
      debitCents: l.debitCents ?? 0,
      creditCents: l.creditCents ?? 0,
      memo: l.memo ?? null,
    })),
  });

  await auditAs(principal, "CREATE", "JournalEntry", entry.id, { number: entry.number, memo: input.memo }, request);
  return ok(entry, undefined, { status: 201 });
});
