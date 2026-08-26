import { handler } from "@/lib/api";
import { companyIdOf } from "@/lib/tenant";
import { trialBalance, trialBalanceTotals } from "@/server/ledger";

export const dynamic = "force-dynamic";

/**
 * The trial balance, and whether it balances.
 *
 * `balanced` is not decoration. If it is ever false the books are broken, and
 * every figure derived from them — profit, tax owed, what a customer owes — is
 * suspect. It is asserted in the smoke suite for exactly that reason.
 */
export const GET = handler({ permission: "report:financial" }, async ({ principal, searchParams }) => {
  const companyId = companyIdOf(principal);

  const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : undefined;
  const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : undefined;

  const [rows, totals] = await Promise.all([
    trialBalance(companyId, { from, to }),
    trialBalanceTotals(companyId, { from, to }),
  ]);

  return {
    ...totals,
    // Accounts that have never been posted to are noise on a trial balance.
    rows: rows.filter((r) => r.debitCents !== 0 || r.creditCents !== 0),
  };
});
