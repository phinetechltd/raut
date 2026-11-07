import { z } from "zod";

import { badRequest, handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { momentForDay } from "@/lib/report-engine";
import { companyIdOf, scope } from "@/lib/tenant";
import { createBill } from "@/server/payables";

export const dynamic = "force-dynamic";

function dayToDate(day: string, field: string): Date {
  const moment = momentForDay(day);
  if (!moment) throw badRequest(`${field} must be a real calendar day, as YYYY-MM-DD`);
  return moment;
}

export const GET = handler({ permission: "finance:read" }, async ({ principal, searchParams }) => {
  const page = pagination(searchParams);
  const q = searchParams.get("q")?.trim();
  const status = searchParams.get("status");
  const where = {
    ...scope(principal),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q } },
            { supplierRef: { contains: q } },
            { supplier: { name: { contains: q } } },
          ],
        }
      : {}),
  };
  const [bills, total] = await Promise.all([
    db.supplierInvoice.findMany({
      where,
      include: { supplier: { select: { id: true, name: true, taxPin: true } } },
      orderBy: { issueDate: "desc" },
      take: page.take,
      skip: page.skip,
    }),
    db.supplierInvoice.count({ where }),
  ]);
  return ok(bills, paginationMeta(page, total));
});

const schema = z.object({
  supplierId: z.string().min(1),
  supplierRef: z.string().trim().min(1).max(60),
  issueDate: z.string(),
  dueDate: z.string().nullish(),
  netCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  expenseAccountId: z.string().nullish(),
  note: z.string().trim().max(200).nullish(),
});

export const POST = handler({ permission: "payable:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const bill = await createBill(companyIdOf(principal), principal.userId, {
    supplierId: input.supplierId,
    supplierRef: input.supplierRef,
    issueDate: dayToDate(input.issueDate, "issueDate"),
    dueDate: input.dueDate ? dayToDate(input.dueDate, "dueDate") : null,
    netCents: input.netCents,
    taxCents: input.taxCents,
    expenseAccountId: input.expenseAccountId ?? null,
    note: input.note ?? null,
  });
  await auditAs(principal, "CREATE", "SupplierInvoice", bill.id, { number: bill.number, total: bill.totalCents }, request);
  return ok(bill, undefined, { status: 201 });
});
