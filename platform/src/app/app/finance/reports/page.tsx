import { notFound } from "next/navigation";

import {
  ButtonLink,
  Callout,
  Card,
  FilterTabs,
  ModuleLocked,
  Money,
  PageHeader,
  SectionHeading,
  StatCard,
  StatGrid,
} from "@/components/ui";
import { can } from "@/lib/rbac";
import { requireTenant } from "@/lib/session";
import {
  balanceSheet,
  cashFlow,
  describePeriod,
  monthPeriod,
  profitAndLoss,
  stockValuation,
  vatSummary,
  yearToDate,
  type Period,
  type ReportLine,
} from "@/server/reports";

export const dynamic = "force-dynamic";

const REPORTS = [
  { value: "pl", label: "Profit & loss" },
  { value: "balance", label: "Balance sheet" },
  { value: "cash", label: "Cash flow" },
  { value: "vat", label: "VAT" },
  { value: "stock", label: "Stock valuation" },
] as const;

type ReportKey = (typeof REPORTS)[number]["value"];

/** The last twelve months, newest first, as picker options. */
function monthOptions(now = new Date()) {
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({
      value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString("en-KE", { month: "short", year: "numeric", timeZone: "UTC" }),
    });
  }
  return out;
}

/**
 * One row of a statement. Indented lines are detail; the bold ones are the
 * subtotals people actually read, so they get the visual weight.
 */
function Line({
  label,
  code,
  cents,
  strong,
  muted,
}: {
  label: string;
  code?: string;
  cents: number;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-baseline justify-between gap-4 py-1.5",
        strong ? "border-t border-border pt-2 font-semibold" : "",
        muted ? "text-content-secondary" : "",
      ].join(" ")}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        {code && <span className="tabular text-xs text-content-muted">{code}</span>}
        <span className="truncate">{label}</span>
      </span>
      <span className={strong ? "" : "text-content-secondary"}>
        <Money cents={cents} />
      </span>
    </div>
  );
}

function Section({ title, lines }: { title: string; lines: ReportLine[] }) {
  if (lines.length === 0) return null;
  return (
    <>
      <p className="mt-4 text-xs font-medium uppercase tracking-wide text-content-muted">
        {title}
      </p>
      {lines.map((l) => (
        <Line key={l.code} code={l.code} label={l.name} cents={l.amountCents} />
      ))}
    </>
  );
}

const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;

export default async function FinanceReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string; month?: string }>;
}) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("FINANCE")) return <ModuleLocked module="FINANCE" />;

  // A field rep holds report:read and would otherwise reach this page, which
  // carries the company's margin, cash position and tax liability. 404 rather
  // than 403 keeps the existence of the page itself need-to-know.
  if (!can(principal, "report:financial")) notFound();

  const sp = await searchParams;
  const report = (REPORTS.find((r) => r.value === sp.report)?.value ?? "pl") as ReportKey;

  const months = monthOptions();
  const month = sp.month && months.some((m) => m.value === sp.month) ? sp.month : null;
  const period: Period = month ? monthPeriod(month) : yearToDate();

  const query = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { report, month, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return p.toString();
  };

  // The API is the same code path the console reads, so an exported CSV can
  // never disagree with the figures on screen.
  const csvHref =
    {
      pl: `/api/v1/reports/profit-and-loss?format=csv`,
      balance: `/api/v1/reports/balance-sheet?format=csv`,
      cash: `/api/v1/reports/cash-flow?format=csv`,
      vat: `/api/v1/reports/vat-summary?format=csv`,
      stock: `/api/v1/reports/stock-valuation?format=csv`,
    }[report] + (month && report !== "stock" && report !== "balance" ? `&month=${month}` : "");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Financial reports"
        breadcrumb={{ href: "/app/finance", label: "Finance" }}
        description={
          report === "stock"
            ? "Valued at current cost price."
            : report === "balance"
              ? `As at ${period.to.toISOString().slice(0, 10)}.`
              : `${describePeriod(period)}. Every figure is read from the ledger.`
        }
        actions={
          <ButtonLink href={csvHref} download variant="secondary" size="sm">
            Export CSV
          </ButtonLink>
        }
      />

      <FilterTabs
        options={REPORTS.map((r) => ({ value: r.value, label: r.label }))}
        active={report}
        hrefFor={(v) => `/app/finance/reports?${query({ report: v })}`}
      />

      {report !== "stock" && (
        <FilterTabs
          options={[{ value: "ytd", label: "Year to date" }, ...months]}
          active={month ?? "ytd"}
          hrefFor={(v) => `/app/finance/reports?${query({ month: v === "ytd" ? null : v })}`}
        />
      )}

      {report === "pl" && <ProfitAndLossView companyId={companyId} period={period} />}
      {report === "balance" && <BalanceSheetView companyId={companyId} asOf={period.to} />}
      {report === "cash" && <CashFlowView companyId={companyId} period={period} />}
      {report === "vat" && <VatView companyId={companyId} period={period} />}
      {report === "stock" && <StockValuationView companyId={companyId} />}
    </div>
  );
}

async function ProfitAndLossView({ companyId, period }: { companyId: string; period: Period }) {
  const r = await profitAndLoss(companyId, period, { comparatives: true });

  const delta = (now: number, before?: number) => {
    if (before === undefined || before === 0) return undefined;
    const change = Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
    return {
      direction: (change > 0 ? "up" : change < 0 ? "down" : "flat") as "up" | "down" | "flat",
      label: `${change > 0 ? "+" : ""}${change}% on prior period`,
    };
  };

  return (
    <>
      <StatGrid>
        <StatCard
          label="Revenue"
          value={<Money cents={r.revenueTotal} />}
          trend={delta(r.revenueTotal, r.prior?.revenueTotal)}
        />
        <StatCard
          label="Gross profit"
          value={<Money cents={r.grossProfit} />}
          hint={`${pct(r.grossMarginBp)} margin`}
          trend={delta(r.grossProfit, r.prior?.grossProfit)}
        />
        <StatCard
          label="Net profit"
          value={<Money cents={r.netProfit} />}
          hint={`${pct(r.netMarginBp)} margin`}
          tone={r.netProfit < 0 ? "danger" : "success"}
          trend={delta(r.netProfit, r.prior?.netProfit)}
        />
      </StatGrid>

      <Card>
        <SectionHeading title="Profit and loss" />
        <Section title="Revenue" lines={r.revenue} />
        <Line label="Total revenue" cents={r.revenueTotal} strong />

        <Section title="Cost of sales" lines={r.costOfSales} />
        <Line label="Gross profit" cents={r.grossProfit} strong />

        <Section title="Expenses" lines={r.expenses} />
        <Line label="Total expenses" cents={r.expensesTotal} strong />

        <div className="mt-3">
          <Line label="Net profit" cents={r.netProfit} strong />
        </div>
      </Card>
    </>
  );
}

async function BalanceSheetView({ companyId, asOf }: { companyId: string; asOf: Date }) {
  const r = await balanceSheet(companyId, asOf);

  return (
    <>
      {!r.balanced && (
        <Callout tone="danger" title="This balance sheet does not balance">
          Assets differ from liabilities plus equity by{" "}
          <Money cents={r.differenceCents} />. Something has been posted that this
          report cannot classify — treat every figure here as unreliable until it is
          found.
        </Callout>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <SectionHeading title="Assets" />
          {r.assets.map((l) => (
            <Line key={l.code} code={l.code} label={l.name} cents={l.amountCents} />
          ))}
          <Line label="Total assets" cents={r.assetsTotal} strong />
        </Card>

        <Card>
          <SectionHeading title="Liabilities and equity" />
          <Section title="Liabilities" lines={r.liabilities} />
          <Line label="Total liabilities" cents={r.liabilitiesTotal} strong />

          <Section title="Equity" lines={r.equity} />
          <Line label="Total equity" cents={r.equityTotal} strong />

          <div className="mt-3">
            <Line
              label="Liabilities and equity"
              cents={r.liabilitiesTotal + r.equityTotal}
              strong
            />
          </div>
        </Card>
      </div>
    </>
  );
}

async function CashFlowView({ companyId, period }: { companyId: string; period: Period }) {
  const r = await cashFlow(companyId, period);

  return (
    <>
      <StatGrid>
        <StatCard label="Opening cash" value={<Money cents={r.opening} />} />
        <StatCard
          label="Net movement"
          value={<Money cents={r.netMovement} />}
          tone={r.netMovement < 0 ? "warning" : "success"}
        />
        <StatCard label="Closing cash" value={<Money cents={r.closing} />} />
      </StatGrid>

      {!r.reconciles && (
        <Callout tone="danger" title="Cash flow does not reconcile">
          The movement this report explains differs from the movement the cash
          accounts show by{" "}
          <Money cents={r.netMovement - r.actualMovement} />. That should be
          impossible while every entry balances, so it points at a posting rule
          rather than at the data.
        </Callout>
      )}

      <Card>
        <SectionHeading
          title="Cash flow"
          description="Indirect method — profit, adjusted for everything that is not cash."
        />
        <Line label="Net profit for the period" cents={r.netProfit} />
        <Section title="Working capital" lines={r.workingCapital} />
        <Line label="Net working capital movement" cents={r.workingCapitalTotal} strong />
        <Section title="Equity" lines={r.equityMovements} />
        <div className="mt-3">
          <Line label="Net movement in cash" cents={r.netMovement} strong />
        </div>
        <Line label="Opening cash" cents={r.opening} muted />
        <Line label="Closing cash" cents={r.closing} strong />
      </Card>
    </>
  );
}

async function VatView({ companyId, period }: { companyId: string; period: Period }) {
  const r = await vatSummary(companyId, period);

  return (
    <>
      <StatGrid>
        <StatCard label="Output VAT charged" value={<Money cents={r.outputCents} />} />
        <StatCard label="Input VAT recoverable" value={<Money cents={r.inputCents} />} />
        <StatCard
          label={r.refundDue ? "VAT refundable" : "VAT payable"}
          value={<Money cents={Math.abs(r.payableCents)} />}
          tone={r.refundDue ? "info" : "warning"}
        />
      </StatGrid>

      <Card>
        <SectionHeading
          title="VAT summary"
          description="The figures a KRA return is built from, taken from the ledger."
        />
        <Line label="Taxable sales, excluding VAT" cents={r.salesCents} />
        <Line code="2100" label="Output VAT charged on sales" cents={r.outputCents} />
        <Line code="2110" label="Input VAT recoverable on purchases" cents={r.inputCents} muted />
        <Line
          label={r.refundDue ? "VAT refundable" : "VAT payable to KRA"}
          cents={Math.abs(r.payableCents)}
          strong
        />
      </Card>
    </>
  );
}

async function StockValuationView({ companyId }: { companyId: string }) {
  const r = await stockValuation(companyId);

  const byLocation = new Map<string, typeof r.rows>();
  for (const row of r.rows) {
    const list = byLocation.get(row.locationName) ?? [];
    list.push(row);
    byLocation.set(row.locationName, list);
  }

  return (
    <>
      <StatGrid>
        <StatCard label="Stock at cost" value={<Money cents={r.totalCents} />} />
        <StatCard label="Inventory account (1300)" value={<Money cents={r.ledgerCents} />} />
        <StatCard
          label="Difference"
          value={<Money cents={r.variesBy} />}
          tone={r.variesBy === 0 ? "success" : "warning"}
          hint={r.variesBy === 0 ? "Stock agrees with the ledger" : "Goods moved without a posting"}
        />
      </StatGrid>

      {r.variesBy !== 0 && (
        <Callout tone="warning" title="Stock on hand does not match the inventory account">
          These two are counted from different places — quantities from stock
          records, the balance from posted movements. A difference of{" "}
          <Money cents={r.variesBy} /> means goods moved without being booked, or
          were booked at a cost that has since changed.
        </Callout>
      )}

      {[...byLocation.entries()].map(([location, rows]) => (
        <Card key={location}>
          <SectionHeading title={location} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-content-muted">
                  <th className="py-2 pr-3 font-medium">SKU</th>
                  <th className="py-2 pr-3 font-medium">Product</th>
                  <th className="py-2 pr-3 text-right font-medium">Qty</th>
                  <th className="py-2 pr-3 text-right font-medium">Unit cost</th>
                  <th className="py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.productId} className="border-t border-border">
                    <td className="py-2 pr-3 tabular text-content-muted">{row.sku}</td>
                    <td className="py-2 pr-3">{row.name}</td>
                    <td className="py-2 pr-3 text-right tabular">{row.quantity}</td>
                    <td className="py-2 pr-3 text-right tabular">
                      <Money cents={row.unitCostCents} />
                    </td>
                    <td className="py-2 text-right tabular font-medium">
                      <Money cents={row.valueCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </>
  );
}
