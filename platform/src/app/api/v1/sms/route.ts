import { z } from "zod";

import { handler, ok, pagination, paginationMeta, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { formatKES } from "@/lib/money";
import { queueSms, renderTemplate, type SmsTemplateKey } from "@/lib/sms";
import { companyIdOf, scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "sms:read" },
  async ({ principal, searchParams }) => {
    const page = pagination(searchParams);
    const where = {
      ...scope(principal),
      ...(searchParams.get("status") ? { status: searchParams.get("status")! } : {}),
    };

    const [items, total, templates] = await Promise.all([
      db.smsMessage.findMany({
        where,
        include: { customer: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: page.take,
        skip: page.skip,
      }),
      db.smsMessage.count({ where }),
      db.smsTemplate.findMany({ where: scope(principal), orderBy: { key: "asc" } }),
    ]);

    const spend = await db.smsMessage.aggregate({
      where: { ...scope(principal), status: { in: ["SENT", "DELIVERED"] } },
      _sum: { costCents: true },
    });

    return ok(items, {
      ...paginationMeta(page, total),
      templates,
      provider: process.env.SMS_PROVIDER ?? "console",
      totalSpendCents: spend._sum.costCents ?? 0,
    });
  },
);

const schema = z
  .object({
    /** Explicit recipients, or a filter to build the list from. */
    customerIds: z.array(z.string()).optional(),
    audience: z.enum(["ALL", "WITH_BALANCE", "OVERDUE", "TERRITORY"]).optional(),
    territoryId: z.string().optional(),
    templateKey: z
      .enum([
        "ORDER_CONFIRMATION",
        "PAYMENT_RECEIPT",
        "BALANCE_REMINDER",
        "PROMOTION",
        "VISIT_REMINDER",
      ])
      .optional(),
    message: z.string().optional(),
  })
  .refine((v) => v.templateKey || v.message, {
    message: "Provide either a templateKey or a message body",
  });

/**
 * Bulk send. Recipients are resolved server-side from an audience rather than
 * trusting a client-supplied blast list, so a compromised console session
 * cannot message another tenant's customers.
 */
export const POST = handler(
  { permission: "sms:send" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    const company = await db.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { name: true },
    });

    const where: Record<string, unknown> = { companyId, status: "ACTIVE" };
    if (input.customerIds?.length) where.id = { in: input.customerIds };
    else if (input.audience === "WITH_BALANCE") where.balanceCents = { gt: 0 };
    else if (input.audience === "OVERDUE") {
      where.invoices = { some: { status: "OVERDUE" } };
    } else if (input.audience === "TERRITORY" && input.territoryId) {
      where.territoryId = input.territoryId;
    }

    const customers = await db.customer.findMany({
      where: { ...where, phone: { not: null } },
      select: { id: true, name: true, phone: true, balanceCents: true },
    });

    if (customers.length === 0) {
      return ok({ sent: 0, failed: 0, messages: [] });
    }

    const template = input.templateKey
      ? await db.smsTemplate.findUnique({
          where: {
            companyId_key: { companyId, key: input.templateKey as SmsTemplateKey },
          },
        })
      : null;

    const results = [];
    for (const customer of customers) {
      const body = template
        ? renderTemplate(template.body, {
            customer: customer.name,
            balance: formatKES(customer.balanceCents),
            amount: formatKES(customer.balanceCents),
            company: company.name,
            date: new Date().toLocaleDateString("en-KE"),
            message: input.message ?? "",
          })
        : renderTemplate(input.message!, {
            customer: customer.name,
            balance: formatKES(customer.balanceCents),
            company: company.name,
          });

      results.push(
        await queueSms({
          companyId,
          customerId: customer.id,
          toPhone: customer.phone!,
          body,
          templateKey: input.templateKey ?? null,
        }),
      );
    }

    const sent = results.filter((r) => r.status === "SENT").length;

    await auditAs(principal, "CREATE", "SmsBatch", null, {
      recipients: results.length,
      sent,
      templateKey: input.templateKey,
    }, request);

    return { sent, failed: results.length - sent, messages: results };
  },
);
