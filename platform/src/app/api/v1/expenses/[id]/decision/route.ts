import { z } from "zod";

import { conflict, forbidden, handler, notFound, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";
import { postExpense } from "@/server/posting";

export const dynamic = "force-dynamic";

const schema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
});

/**
 * Approve or reject a claim. Note `scope()` is called without `selfField` on
 * purpose — approving is precisely the action a rep must not perform on their
 * own claim, and the permission gate already keeps reps out.
 *
 * Approval is the moment the expense becomes real money: the journal entry
 * (Dr the category's account, Cr Cash) is written in the same transaction as
 * the status change, so an approved claim can never exist without its entry
 * and the P&L can never show spend the approver has not signed off.
 */
export const POST = handler<{ id: string }>(
  { permission: "expense:approve" },
  async ({ principal, params, request }) => {
    const expense = await db.expense.findFirst({
      where: { id: params.id, ...scope(principal) },
      include: { category: { select: { accountCode: true } } },
    });
    if (!expense) throw notFound("Expense not found");

    if (expense.userId === principal.userId) {
      throw forbidden("You cannot approve your own expense claim");
    }

    const input = await parseBody(request, schema);

    // Once approved the claim is in the books. Reversing that is a journal
    // reversal, not a status flip, so a decided claim cannot be re-decided.
    if (expense.status === "APPROVED" || expense.status === "PAID") {
      throw conflict(`This claim is already ${expense.status.toLowerCase()}`);
    }

    const updated = await db.$transaction(
      async (tx) => {
        const row = await tx.expense.update({
          where: { id: params.id },
          data: {
            status: input.decision,
            approvedById: principal.userId,
            approvedAt: new Date(),
            rejectReason: input.decision === "REJECTED" ? (input.reason ?? null) : null,
          },
        });

        if (input.decision === "APPROVED") {
          await postExpense(
            tx,
            {
              id: row.id,
              companyId: row.companyId,
              number: row.number,
              spentAt: row.incurredAt,
              amountCents: row.amountCents,
              categoryAccountCode: expense.category?.accountCode ?? null,
            },
            principal.userId,
          );
        }

        return row;
      },
      { timeout: 15_000 },
    );

    await auditAs(
      principal,
      input.decision === "APPROVED" ? "APPROVE" : "REJECT",
      "Expense",
      updated.id,
      { number: updated.number, reason: input.reason },
      request,
    );

    return updated;
  },
);
