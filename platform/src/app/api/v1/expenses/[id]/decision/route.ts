import { z } from "zod";

import { handler, notFound, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const schema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
});

/**
 * Approve or reject a claim. Note `scope()` is called without `selfField` on
 * purpose — approving is precisely the action a rep must not perform on their
 * own claim, and the permission gate already keeps reps out.
 */
export const POST = handler<{ id: string }>(
  { permission: "expense:approve" },
  async ({ principal, params, request }) => {
    const expense = await db.expense.findFirst({
      where: { id: params.id, ...scope(principal) },
    });
    if (!expense) throw notFound("Expense not found");

    if (expense.userId === principal.userId) {
      throw new Error("You cannot approve your own expense claim");
    }

    const input = await parseBody(request, schema);

    const updated = await db.expense.update({
      where: { id: params.id },
      data: {
        status: input.decision,
        approvedById: principal.userId,
        approvedAt: new Date(),
        rejectReason: input.decision === "REJECTED" ? (input.reason ?? null) : null,
      },
    });

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
