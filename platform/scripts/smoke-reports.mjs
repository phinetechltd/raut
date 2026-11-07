/**
 * End-to-end proof that the report library and accounting tools tell the truth.
 *
 * Runs every report, then checks the figures against each other: the ledger must
 * balance, the sub-ledgers must agree with their control accounts, and a journal
 * or bill entered through the API must land in exactly the reports it should.
 *
 *   node scripts/smoke-reports.mjs [baseUrl]
 *
 * Posts real entries, so point it at a development database, never production.
 */

const BASE = process.argv[2] ?? "http://localhost:3200";
const API = `${BASE}/api/v1`;
const PASSWORD = "Raut@2026";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // CSV and other plain responses.
  }
  return { status: res.status, json, text, data: json?.data, code: json?.error?.code, type: res.headers.get("content-type") };
}

async function signIn(email) {
  const res = await call("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  if (res.status !== 200) throw new Error(`Could not sign in as ${email}: ${res.status}`);
  return res.data.accessToken;
}

const report = (key, query = "", token) => call(`/reports/library/${key}${query ? `?${query}` : ""}`, { token });
const summaryOf = (run, label) => run.data?.summary?.find((s) => s.label === label)?.value;

const uid = Date.now().toString(36).toUpperCase();
const nairobiToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
function previousMonth() {
  const [y, m] = nairobiToday().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const admin = await signIn("admin@tarisolutions.co.ke");
  const accountant = await signIn("accounts@tarisolutions.co.ke");
  const sales = await signIn("sales@tarisolutions.co.ke");
  const stores = await signIn("stores@tarisolutions.co.ke");
  const rep = await signIn("rep@tarisolutions.co.ke");
  const platform = await signIn("admin@tariafrica.com");
  const other = await signIn("admin@acacia.example");

  console.log("\n  Every report runs");
  const catalogue = await call("/reports/library", { token: admin });
  const reports = catalogue.data?.reports ?? [];
  check("The catalogue lists the library", reports.length >= 40, String(reports.length));
  for (const r of reports) {
    const run = await report(r.key, "range=all", admin);
    check(`${r.title} runs`, run.status === 200 && Array.isArray(run.data?.rows) && run.data?.columns?.length > 0, `${run.status} ${run.code ?? ""}`);
    const shaped = (run.data?.rows ?? []).every((row) => run.data.columns.every((c) => c.key in row));
    check(`${r.title} has every column in every row`, shaped);
    const csv = await report(r.key, "range=all&format=csv", admin);
    check(`${r.title} exports`, csv.status === 200 && (csv.type ?? "").includes("text/csv") && csv.text.includes(run.data?.columns?.[0]?.label ?? "?"), String(csv.status));
  }
  const missing = await report("no-such-report", "", admin);
  check("An unknown report is a 404", missing.status === 404, String(missing.status));

  console.log("\n  Who may run what");
  check("A rep cannot run the trial balance", (await report("trial-balance", "", rep)).status === 403);
  check("A rep cannot run the VAT return", (await report("vat-return", "", rep)).status === 403);
  check("A storekeeper cannot read the sales book", (await report("sales-register", "", stores)).status === 403);
  check("A storekeeper can read the reorder list", (await report("reorder-list", "", stores)).status === 200);
  check("An unlicensed company is told it is the licence", (await report("trial-balance", "", other)).status === 402);
  check("Anonymous is refused", (await report("trial-balance")).status === 401);
  const repCatalogue = await call("/reports/library", { token: rep });
  check("A rep's catalogue leaves out what they cannot run", !repCatalogue.data?.reports?.some((r) => r.key === "trial-balance"));
  const repVisits = await report("visit-log", "range=all", rep);
  const repNames = new Set((repVisits.data?.rows ?? []).map((r) => r.rep));
  check("A rep sees only their own visits", repVisits.status === 200 && repNames.size <= 1, [...repNames].join(", "));

  console.log("\n  The books agree with themselves");
  const tb = await report("trial-balance", "range=all", admin);
  check("Debits equal credits", summaryOf(tb, "Difference") === 0, String(summaryOf(tb, "Difference")));
  check("The table adds up to the summary", tb.data?.totals?.closingDebitCents === summaryOf(tb, "Total debits"));

  const year = nairobiToday().slice(0, 4);
  const byMonth = await report("pl-by-month", "range=ytd", admin);
  const statement = await call(`/reports/profit-and-loss?from=${year}-01-01&to=${year}-12-31`, { token: admin });
  check("Monthly profit adds up to the P&L statement", byMonth.data?.totals?.netCents === statement.data?.netProfit, `${byMonth.data?.totals?.netCents} vs ${statement.data?.netProfit}`);
  check("Monthly revenue adds up to the P&L statement", byMonth.data?.totals?.revenueCents === statement.data?.revenueTotal);

  const ar = await report("ar-ageing", "", admin);
  check("Receivables ageing agrees with the ledger", summaryOf(ar, "Difference") === 0, String(summaryOf(ar, "Difference")));
  const buckets = ["currentCents", "d1_30Cents", "d31_60Cents", "d61_90Cents", "d90PlusCents", "unallocatedCents"];
  check("Ageing columns add up to the balance", buckets.reduce((n, k) => n + (ar.data?.totals?.[k] ?? 0), 0) === ar.data?.totals?.totalCents);

  const month = nairobiToday().slice(0, 7);
  const vatBefore = await report("vat-return", `month=${month}`, admin);
  const vatSummary = await call(`/reports/vat-summary?month=${month}`, { token: admin });
  check("VAT workings agree with the ledger", summaryOf(vatBefore, "Check against the ledger") === "Agrees");
  check("Output VAT equals the VAT summary", summaryOf(vatBefore, "Output VAT") === vatSummary.data?.outputCents, `${summaryOf(vatBefore, "Output VAT")} vs ${vatSummary.data?.outputCents}`);

  const register = await report("vat-sales-register", `month=${month}`, admin);
  const registerVat = register.data?.totals?.vatCents ?? 0;
  check("The sales register's VAT equals the return's", registerVat === summaryOf(vatBefore, "Output VAT"), `${registerVat}`);

  console.log("\n  The chart of accounts");
  const chart = (await call("/finance/accounts", { token: admin })).data ?? [];
  const byCode = (code) => chart.find((a) => a.code === code);
  check("The chart lists balances", chart.length >= 10 && "balanceCents" in chart[0]);
  const wrongPrefix = await call("/finance/accounts", { method: "POST", token: admin, body: { code: "6123", name: "Wrong", type: "ASSET" } });
  check("A code that contradicts its type is refused", wrongPrefix.status === 422, String(wrongPrefix.status));
  const code = String(60000 + (Date.now() % 9999));
  const rent = await call("/finance/accounts", { method: "POST", token: admin, body: { code, name: `Rent ${uid}`, type: "EXPENSE" } });
  check("An admin can add an account", rent.status === 201, `${rent.status} ${JSON.stringify(rent.json?.error ?? "")}`);
  const duplicate = await call("/finance/accounts", { method: "POST", token: admin, body: { code, name: "Again", type: "EXPENSE" } });
  check("A code cannot be used twice", duplicate.status === 409, String(duplicate.status));
  const salesAccount = await call("/finance/accounts", { method: "POST", token: sales, body: { code: "6999", name: "No", type: "EXPENSE" } });
  check("A sales manager cannot add an account", salesAccount.status === 403, String(salesAccount.status));
  const retireSystem = await call(`/finance/accounts/${byCode("1000")?.id}`, { method: "PATCH", token: admin, body: { active: false } });
  check("An account used by posting cannot be retired", retireSystem.status === 422, String(retireSystem.status));

  console.log("\n  Journal entries");
  const bank = byCode("1010")?.id;
  const receivable = byCode("1200")?.id;
  const rentId = rent.data?.id;
  const today = nairobiToday();
  const jv = (over = {}) => ({
    date: today,
    memo: `Rent for the office ${uid}`,
    lines: [
      { accountId: rentId, debitCents: 50_000 },
      { accountId: bank, creditCents: 50_000 },
    ],
    ...over,
  });
  const unbalanced = await call("/finance/journal", { method: "POST", token: admin, body: jv({ lines: [{ accountId: rentId, debitCents: 50_000 }, { accountId: bank, creditCents: 40_000 }] }) });
  check("An unbalanced journal is refused", unbalanced.status === 422 && unbalanced.code === "JOURNAL_INVALID", `${unbalanced.status} ${unbalanced.code}`);
  const locked = await call("/finance/journal", { method: "POST", token: admin, body: jv({ lines: [{ accountId: receivable, debitCents: 100 }, { accountId: bank, creditCents: 100 }] }) });
  check("A journal to receivables is refused", locked.status === 422 && locked.code === "ACCOUNT_LOCKED", `${locked.status} ${locked.code}`);
  const future = await call("/finance/journal", { method: "POST", token: admin, body: jv({ date: "2099-01-01" }) });
  check("A journal dated in the future is refused", future.status === 400, String(future.status));
  const badDate = await call("/finance/journal", { method: "POST", token: admin, body: jv({ date: "2026-02-31" }) });
  check("A date that does not exist is refused", badDate.status === 400, String(badDate.status));
  const bySales = await call("/finance/journal", { method: "POST", token: sales, body: jv() });
  check("A sales manager cannot post a journal", bySales.status === 403, String(bySales.status));
  const byRep = await call("/finance/journal", { token: rep });
  check("A rep cannot read the journal", byRep.status === 403, String(byRep.status));

  const bankBefore = (await report("general-ledger", `range=all&s_account=${bank}`, admin));
  const clientUuid = `smoke-${uid}`;
  const posted = await call("/finance/journal", { method: "POST", token: accountant, body: jv({ clientUuid }) });
  check("An accountant can post a balanced journal", posted.status === 201 && /^JV-/.test(posted.data?.number ?? ""), `${posted.status} ${JSON.stringify(posted.json?.error ?? "")}`);
  const replay = await call("/finance/journal", { method: "POST", token: accountant, body: jv({ clientUuid }) });
  check("Resending the same form does not post twice", replay.data?.id === posted.data?.id, `${replay.data?.number} vs ${posted.data?.number}`);

  const gl = await report("general-ledger", `range=all&s_account=${rentId}`, admin);
  check("It appears in that account's ledger", gl.data?.rows?.length === 1 && gl.data.rows[0].debitCents === 50_000);
  check("Its running balance is right", gl.data?.rows?.[0]?.balanceCents === 50_000 && summaryOf(gl, "Closing balance") === 50_000);
  const bankAfter = await report("general-ledger", `range=all&s_account=${bank}`, admin);
  check("It takes the money out of the bank", summaryOf(bankAfter, "Closing balance") === summaryOf(bankBefore, "Closing balance") - 50_000);
  const stillBalanced = await report("trial-balance", "range=all", admin);
  check("The books still balance", summaryOf(stillBalanced, "Difference") === 0);
  const pl = await call(`/reports/profit-and-loss?month=${month}`, { token: admin });
  check("It reaches the P&L as an expense", pl.data?.expenses?.some((e) => e.code === code && e.amountCents === 50_000));

  const previous = previousMonth();
  const inLast = (await report("general-ledger", `month=${previous}&s_account=${rentId}`, admin)).data?.rows?.length;
  check("It is not in last month's ledger", inLast === 0, String(inLast));

  const retireBusy = await call(`/finance/accounts/${rentId}`, { method: "PATCH", token: admin, body: { active: false } });
  check("An account holding a balance cannot be retired", retireBusy.status === 422, String(retireBusy.status));

  const reversal = await call(`/finance/journal/${posted.data?.id}/reverse`, { method: "POST", token: accountant, body: { reason: "Entered in error" } });
  check("It can be reversed", reversal.status === 201, `${reversal.status} ${JSON.stringify(reversal.json?.error ?? "")}`);
  const netted = await report("general-ledger", `range=all&s_account=${rentId}`, admin);
  check("The reversal brings the account to zero", summaryOf(netted, "Closing balance") === 0);
  check("Both entries stay on the record", netted.data?.rows?.length === 2);
  const twice = await call(`/finance/journal/${posted.data?.id}/reverse`, { method: "POST", token: accountant, body: { reason: "Again please" } });
  check("It cannot be reversed twice", twice.status === 409, String(twice.status));

  const systemEntry = (await call("/finance/journal?source=REVENUE&limit=1", { token: admin })).data?.[0];
  if (systemEntry) {
    const reverseSystem = await call(`/finance/journal/${systemEntry.id}/reverse`, { method: "POST", token: admin, body: { reason: "Should not work" } });
    check("A document's own entry cannot be reversed by hand", reverseSystem.status === 422 && reverseSystem.code === "NOT_MANUAL", `${reverseSystem.status} ${reverseSystem.code}`);
  }

  const retired = await call(`/finance/accounts/${rentId}`, { method: "PATCH", token: admin, body: { active: false } });
  check("An empty account can be retired", retired.status === 200 && retired.data?.active === false, String(retired.status));
  const toRetired = await call("/finance/journal", { method: "POST", token: admin, body: jv() });
  check("A retired account takes no more journals", toRetired.status === 422 && toRetired.code === "ACCOUNT_INACTIVE", `${toRetired.status} ${toRetired.code}`);

  console.log("\n  Paying VAT does not change the VAT charged");
  const vatPayable = byCode("2100")?.id;
  const outputBefore = (await call(`/reports/vat-summary?month=${month}`, { token: admin })).data?.outputCents;
  const paidVat = await call("/finance/journal", {
    method: "POST",
    token: accountant,
    body: { date: today, memo: `VAT paid to KRA ${uid}`, lines: [{ accountId: vatPayable, debitCents: 1_000 }, { accountId: bank, creditCents: 1_000 }] },
  });
  check("A VAT payment can be journalled", paidVat.status === 201, String(paidVat.status));
  const outputAfter = (await call(`/reports/vat-summary?month=${month}`, { token: admin })).data?.outputCents;
  check("Output VAT is unchanged by it", outputAfter === outputBefore, `${outputBefore} then ${outputAfter}`);
  await call(`/finance/journal/${paidVat.data?.id}/reverse`, { method: "POST", token: accountant, body: { reason: "Test entry" } });

  console.log("\n  Supplier bills and input VAT");
  const suppliers = (await call("/suppliers", { token: admin })).data ?? [];
  const supplier = suppliers[0];
  check("A supplier exists to bill from", Boolean(supplier?.id));
  const inputBefore = summaryOf(await report("vat-return", `month=${month}`, admin), "Input VAT");
  const billBody = { supplierId: supplier?.id, supplierRef: `SUP-${uid}`, issueDate: today, netCents: 100_000, taxCents: 16_000 };
  const bill = await call("/supplier-invoices", { method: "POST", token: accountant, body: billBody });
  check("A bill can be entered", bill.status === 201 && bill.data?.totalCents === 116_000, `${bill.status} ${JSON.stringify(bill.json?.error ?? "")}`);
  const dupBill = await call("/supplier-invoices", { method: "POST", token: accountant, body: billBody });
  check("The same supplier invoice cannot be entered twice", dupBill.status === 409, String(dupBill.status));
  const salesBill = await call("/supplier-invoices", { method: "POST", token: sales, body: { ...billBody, supplierRef: `X-${uid}` } });
  check("A sales manager cannot enter a bill", salesBill.status === 403, String(salesBill.status));

  const vatAfterBill = await report("vat-return", `month=${month}`, admin);
  check("Its VAT reaches the return as input tax", summaryOf(vatAfterBill, "Input VAT") === inputBefore + 16_000, String(summaryOf(vatAfterBill, "Input VAT")));
  check("The return still agrees with the ledger", summaryOf(vatAfterBill, "Check against the ledger") === "Agrees");
  const purchases = await report("vat-purchases-register", `month=${month}&q=SUP-${uid}`, admin);
  check("It is on the purchases register", purchases.data?.rows?.length === 1 && purchases.data.rows[0].vatCents === 16_000);
  const apAfter = await report("ap-ageing", "", admin);
  check("Payables ageing agrees with the ledger", summaryOf(apAfter, "Difference") === 0, String(summaryOf(apAfter, "Difference")));

  const over = await call(`/supplier-invoices/${bill.data?.id}/payments`, { method: "POST", token: accountant, body: { amountCents: 999_999, paidAt: today, account: "BANK" } });
  check("A payment over what is owed is refused", over.status === 422 && over.code === "OVERPAYMENT", `${over.status} ${over.code}`);
  const payUuid = `smokepay-${uid}`;
  const part = await call(`/supplier-invoices/${bill.data?.id}/payments`, { method: "POST", token: accountant, body: { amountCents: 16_000, paidAt: today, account: "BANK", clientUuid: payUuid } });
  check("A part payment is recorded", part.status === 201, `${part.status} ${JSON.stringify(part.json?.error ?? "")}`);
  const partAgain = await call(`/supplier-invoices/${bill.data?.id}/payments`, { method: "POST", token: accountant, body: { amountCents: 16_000, paidAt: today, account: "BANK", clientUuid: payUuid } });
  check("Resending it does not pay twice", partAgain.data?.id === part.data?.id);
  const bills = (await call(`/supplier-invoices?q=SUP-${uid}`, { token: accountant })).data ?? [];
  check("The bill shows as part paid", bills[0]?.status === "PARTIALLY_PAID" && bills[0]?.paidCents === 16_000, `${bills[0]?.status} ${bills[0]?.paidCents}`);
  const voidPaid = await call(`/supplier-invoices/${bill.data?.id}/void`, { method: "POST", token: accountant, body: { reason: "Should not work" } });
  check("A bill with payments cannot be voided", voidPaid.status === 422, String(voidPaid.status));
  const rest = await call(`/supplier-invoices/${bill.data?.id}/payments`, { method: "POST", token: accountant, body: { amountCents: 100_000, paidAt: today, account: "CASH" } });
  check("The balance can be paid", rest.status === 201, String(rest.status));
  const settled = (await call(`/supplier-invoices?q=SUP-${uid}`, { token: accountant })).data ?? [];
  check("The bill then shows as paid", settled[0]?.status === "PAID");
  const payments = await report("supplier-payments", `month=${month}&q=${settled[0]?.number}`, admin);
  check("Both payments are on the register", payments.data?.rows?.length === 2 && payments.data?.totals?.amountCents === 116_000);

  const toVoid = await call("/supplier-invoices", { method: "POST", token: accountant, body: { ...billBody, supplierRef: `VOID-${uid}` } });
  const voided = await call(`/supplier-invoices/${toVoid.data?.id}/void`, { method: "POST", token: accountant, body: { reason: "Entered in error" } });
  check("An unpaid bill can be voided", voided.status === 200 && voided.data?.status === "VOID", String(voided.status));
  const reenter = await call("/supplier-invoices", { method: "POST", token: accountant, body: { ...billBody, supplierRef: `VOID-${uid}`, netCents: 1000, taxCents: 160 } });
  check("A voided invoice number can be entered again", reenter.status === 201, String(reenter.status));
  await call(`/supplier-invoices/${reenter.data?.id}/void`, { method: "POST", token: accountant, body: { reason: "Test entry" } });
  const vatAfterVoid = await report("vat-return", `month=${month}`, admin);
  check("A voided bill leaves the return agreeing with the ledger", summaryOf(vatAfterVoid, "Check against the ledger") === "Agrees");
  check("Voided bills claim no input VAT", summaryOf(vatAfterVoid, "Input VAT") === inputBefore + 16_000, String(summaryOf(vatAfterVoid, "Input VAT")));

  const control = await report("control-reconciliation", "", admin);
  const apRow = control.data?.rows?.find((r) => r.control.startsWith("2000"));
  const arRow = control.data?.rows?.find((r) => r.control.startsWith("1200"));
  check("Payables agree with unpaid bills", apRow?.state === "AGREES", JSON.stringify(apRow));
  check("Receivables agree with customer balances", arRow?.state === "AGREES", JSON.stringify(arRow));
  const stillOk = await report("trial-balance", "range=all", admin);
  check("After all of that the books still balance", summaryOf(stillOk, "Difference") === 0);

  console.log("\n  Closing a month");
  const midLast = `${previous}-15`;
  const currentClose = await call("/finance/periods", { method: "POST", token: accountant, body: { month, action: "close" } });
  check("The current month cannot be closed", currentClose.status === 422 && currentClose.code === "PERIOD_NOT_OVER", `${currentClose.status} ${currentClose.code}`);
  const closeBySales = await call("/finance/periods", { method: "POST", token: sales, body: { month: previous, action: "close" } });
  check("A sales manager cannot close a month", closeBySales.status === 403, String(closeBySales.status));
  const closed = await call("/finance/periods", { method: "POST", token: accountant, body: { month: previous, action: "close" } });
  check("An accountant can close a past month", closed.status === 200, `${closed.status} ${JSON.stringify(closed.json?.error ?? "")}`);
  try {
    const periods = (await call("/finance/periods", { token: admin })).data ?? [];
    check("The month shows as closed", Boolean(periods.find((p) => p.month === previous)?.closedAt));
    const backdated = await call("/finance/journal", {
      method: "POST",
      token: accountant,
      body: { date: midLast, memo: `Backdated ${uid}`, lines: [{ accountId: byCode("6000")?.id, debitCents: 100 }, { accountId: bank, creditCents: 100 }] },
    });
    check("Nothing can be posted into a closed month", backdated.status === 409 && backdated.code === "LEDGER_REJECTED", `${backdated.status} ${backdated.code}`);
    const backdatedBill = await call("/supplier-invoices", {
      method: "POST",
      token: accountant,
      body: { ...billBody, supplierRef: `BACK-${uid}`, issueDate: midLast },
    });
    check("A bill cannot be backdated into it either", backdatedBill.status === 409, String(backdatedBill.status));
    const leftover = (await call(`/supplier-invoices?q=BACK-${uid}`, { token: accountant })).data ?? [];
    check("A refused bill leaves nothing behind", leftover.length === 0, String(leftover.length));
    const reopenByAccountant = await call("/finance/periods", { method: "POST", token: accountant, body: { month: previous, action: "reopen" } });
    check("An accountant cannot reopen a month", reopenByAccountant.status === 403, String(reopenByAccountant.status));
  } finally {
    const reopened = await call("/finance/periods", { method: "POST", token: admin, body: { month: previous, action: "reopen" } });
    check("An admin can reopen it", reopened.status === 200, String(reopened.status));
  }

  console.log("\n  Tenant isolation");
  const companies = await call("/platform/companies?q=acacia", { token: platform });
  const acacia = (Array.isArray(companies.data) ? companies.data : companies.data?.companies ?? []).find((c) => c.slug === "acacia");
  const license = (enabled) =>
    call(`/platform/companies/${acacia?.id}/modules`, { method: "PUT", token: platform, body: { moduleKey: "FINANCE", enabled } });
  await license(true);
  try {
    const otherJournal = await call(`/finance/journal/${posted.data?.id}`, { token: other });
    check("Another company cannot read this journal", otherJournal.status === 404, String(otherJournal.status));
    const otherReverse = await call(`/finance/journal/${paidVat.data?.id}/reverse`, { method: "POST", token: other, body: { reason: "Not mine" } });
    check("Another company cannot reverse it", otherReverse.status === 404, String(otherReverse.status));
    const otherGl = await report("general-ledger", `range=all&s_account=${bank}`, other);
    check("Another company's ledger cannot follow this account", otherGl.status === 200 && otherGl.data?.rows?.length === 0, String(otherGl.data?.rows?.length));
    const otherChart = (await call("/finance/accounts", { token: other })).data ?? [];
    const otherCash = otherChart.find((a) => a.code === "1000")?.id;
    const foreignLine = await call("/finance/journal", {
      method: "POST",
      token: other,
      body: { date: today, memo: "Reach across", lines: [{ accountId: bank, debitCents: 100 }, { accountId: otherCash, creditCents: 100 }] },
    });
    check("A journal cannot use another company's account", foreignLine.status === 400, String(foreignLine.status));
    const foreignBill = await call("/supplier-invoices", { method: "POST", token: other, body: { ...billBody, supplierRef: `F-${uid}` } });
    check("A bill cannot name another company's supplier", foreignBill.status === 400, String(foreignBill.status));
    const foreignPay = await call(`/supplier-invoices/${bill.data?.id}/payments`, { method: "POST", token: other, body: { amountCents: 1, paidAt: today, account: "BANK" } });
    check("A bill cannot be paid by another company", foreignPay.status === 404, String(foreignPay.status));
    const otherTb = await report("trial-balance", "range=all", other);
    check("Another company's trial balance holds none of this", !otherTb.data?.rows?.some((r) => r.code === code));
  } finally {
    await license(false);
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:\n${failures.map((f) => `    - ${f}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
