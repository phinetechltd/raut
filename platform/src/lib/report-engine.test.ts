import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ageColumn,
  applyRowFilters,
  basisPoints,
  csvCell,
  endOfNairobiDay,
  momentForDay,
  filterOptions,
  formatCell,
  nairobiDate,
  nairobiMonthBounds,
  reportCsvRows,
  reportRange,
  searchRows,
  sortReportRows,
  startOfNairobiDay,
  totalsFor,
  vatClass,
  type ReportColumn,
} from "./report-engine";

const NOW = new Date("2026-11-06T10:00:00Z");

describe("Nairobi periods", () => {
  it("puts a moment just after Nairobi midnight in the new month", () => {
    const bounds = nairobiMonthBounds("2026-11")!;
    const justAfter = new Date("2026-10-31T21:30:00Z");
    assert.ok(justAfter >= bounds.from && justAfter <= bounds.to);
    assert.equal(bounds.from.toISOString(), "2026-10-31T21:00:00.000Z");
    assert.equal(bounds.to.toISOString(), "2026-11-30T20:59:59.999Z");
  });

  it("leaves no gap or overlap between months", () => {
    const oct = nairobiMonthBounds("2026-10")!;
    const nov = nairobiMonthBounds("2026-11")!;
    assert.equal(nov.from.getTime() - oct.to.getTime(), 1);
  });

  it("handles December into January", () => {
    assert.equal(nairobiMonthBounds("2026-12")!.to.toISOString(), "2026-12-31T20:59:59.999Z");
  });

  it("refuses what is not a month or a day", () => {
    assert.equal(nairobiMonthBounds("2026-13"), null);
    assert.equal(nairobiMonthBounds("nope"), null);
    assert.equal(startOfNairobiDay("2026-02-31"), null);
    assert.equal(endOfNairobiDay("x"), null);
  });

  it("includes the whole of the last day", () => {
    assert.equal(endOfNairobiDay("2026-11-06")!.toISOString(), "2026-11-06T20:59:59.999Z");
  });
});

describe("momentForDay", () => {
  it("uses the real time for today, so new entries sort first", () => {
    assert.equal(momentForDay("2026-11-06", NOW)?.getTime(), NOW.getTime());
  });

  it("uses midday for any other day, safely inside the month", () => {
    assert.equal(momentForDay("2026-10-31", NOW)?.toISOString(), "2026-10-31T09:00:00.000Z");
    assert.equal(nairobiDate(momentForDay("2026-11-01", NOW)!), "2026-11-01");
  });

  it("refuses a day that does not exist", () => {
    assert.equal(momentForDay("2026-02-31", NOW), null);
  });
});

describe("reportRange", () => {
  it("defaults to this month", () => {
    const r = reportRange({}, NOW);
    assert.equal(r.key, "this-month");
    assert.equal(nairobiDate(r.from!), "2026-11-01");
    assert.equal(nairobiDate(r.to!), "2026-11-30");
  });

  it("resolves the presets", () => {
    assert.equal(nairobiDate(reportRange({ range: "last-month" }, NOW).from!), "2026-10-01");
    assert.equal(nairobiDate(reportRange({ range: "this-quarter" }, NOW).from!), "2026-10-01");
    assert.equal(nairobiDate(reportRange({ range: "ytd" }, NOW).from!), "2026-01-01");
    const last = reportRange({ range: "last-year" }, NOW);
    assert.equal(nairobiDate(last.from!), "2025-01-01");
    assert.equal(nairobiDate(last.to!), "2025-12-31");
    assert.equal(reportRange({ range: "all" }, NOW).from, null);
  });

  it("rolls last month back across a year", () => {
    const r = reportRange({ range: "last-month" }, new Date("2026-01-15T10:00:00Z"));
    assert.equal(nairobiDate(r.from!), "2025-12-01");
  });

  it("prefers an explicit month, then explicit days", () => {
    assert.equal(nairobiDate(reportRange({ month: "2026-03", range: "ytd" }, NOW).from!), "2026-03-01");
    const custom = reportRange({ from: "2026-03-05", to: "2026-03-09" }, NOW);
    assert.equal(custom.key, "custom");
    assert.equal(nairobiDate(custom.to!), "2026-03-09");
  });

  it("falls back to the default on a date that does not exist, not to all time", () => {
    const r = reportRange({ from: "2026-02-31" }, NOW);
    assert.equal(r.key, "this-month");
    assert.ok(r.from);
  });
});

describe("rows", () => {
  const columns: ReportColumn[] = [
    { key: "name", label: "Name" },
    { key: "doc", label: "Doc", kind: "mono" },
    { key: "amount", label: "Amount", kind: "money", total: true },
    { key: "status", label: "Status", kind: "status" },
  ];
  const rows = [
    { name: "Kariuki Stores", doc: "INV-1", amount: 1000, status: "PAID" },
    { name: "Mwangi Traders", doc: "INV-2", amount: 2550, status: "OVERDUE" },
    { name: "Atieno Ltd", doc: "INV-3", amount: null, status: "PAID" },
  ];

  it("searches text columns, case-insensitively", () => {
    assert.equal(searchRows(rows, columns, "kariuki").length, 1);
    assert.equal(searchRows(rows, columns, "inv-2").length, 1);
    assert.equal(searchRows(rows, columns, "  ").length, 3);
    assert.equal(searchRows(rows, columns, "2550").length, 0);
  });

  it("filters on a row field, with options read from the rows", () => {
    assert.deepEqual(filterOptions(rows, "status").map((o) => o.value), ["OVERDUE", "PAID"]);
    assert.equal(applyRowFilters(rows, [{ key: "status", allLabel: "All" }], { f_status: "PAID" }).length, 2);
    assert.equal(applyRowFilters(rows, [{ key: "status", allLabel: "All" }], {}).length, 3);
  });

  it("sorts both ways and keeps blanks last", () => {
    assert.deepEqual(sortReportRows(rows, "amount", "asc").map((r) => r.amount), [1000, 2550, null]);
    assert.deepEqual(sortReportRows(rows, "amount", "desc").map((r) => r.amount), [2550, 1000, null]);
    assert.equal(sortReportRows(rows, null, "asc"), rows);
  });

  it("sorts dates as dates", () => {
    const dated = [{ at: new Date("2026-02-01") }, { at: new Date("2026-10-01") }];
    assert.equal((sortReportRows(dated, "at", "desc")[0].at as Date).getUTCMonth(), 9);
  });

  it("totals only the columns marked, ignoring blanks", () => {
    assert.deepEqual(totalsFor(rows, columns), { amount: 3550 });
  });
});

describe("formatting", () => {
  it("shows money from cents", () => {
    assert.equal(formatCell(123456, "money"), "1,234.56");
    assert.equal(formatCell(-50, "money"), "-0.50");
    assert.equal(formatCell(null, "money"), "—");
  });

  it("does not hide a real zero", () => {
    assert.equal(formatCell(0, "money"), "0.00");
    assert.equal(formatCell(0, "int"), "0");
  });

  it("dates on the Nairobi calendar", () => {
    assert.equal(formatCell(new Date("2026-10-31T21:30:00Z"), "date"), "2026-11-01");
  });

  it("shows basis points as a percentage", () => {
    assert.equal(formatCell(1234, "pct"), "12.3%");
  });

  it("exports plain numbers", () => {
    assert.equal(csvCell(123456, "money"), "1234.56");
    assert.equal(csvCell(new Date("2026-10-31T21:30:00Z"), "date"), "2026-11-01");
    assert.equal(csvCell(null, "money"), null);
  });

  it("builds a CSV with a heading, summary and total", () => {
    const columns: ReportColumn[] = [
      { key: "name", label: "Name" },
      { key: "amount", label: "Amount", kind: "money", total: true },
    ];
    const csv = reportCsvRows("VAT", "2026-11", [{ name: "A", amount: 100 }, { name: "B", amount: 250 }], columns, [
      { label: "Payable", value: 350, kind: "money" },
    ]);
    assert.deepEqual(csv[0], ["VAT"]);
    assert.deepEqual(csv[3], ["Payable", "3.50"]);
    assert.deepEqual(csv[5], ["Name", "Amount"]);
    assert.deepEqual(csv.at(-1), ["Total", "3.50"]);
  });
});

describe("shared arithmetic", () => {
  it("ages by days past due", () => {
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    assert.equal(ageColumn(null, NOW), "currentCents");
    assert.equal(ageColumn(new Date(NOW.getTime() + 1000), NOW), "currentCents");
    assert.equal(ageColumn(daysAgo(1), NOW), "d1_30Cents");
    assert.equal(ageColumn(daysAgo(30), NOW), "d1_30Cents");
    assert.equal(ageColumn(daysAgo(31), NOW), "d31_60Cents");
    assert.equal(ageColumn(daysAgo(61), NOW), "d61_90Cents");
    assert.equal(ageColumn(daysAgo(91), NOW), "d90PlusCents");
  });

  it("has no percentage of nothing", () => {
    assert.equal(basisPoints(5, 0), null);
    assert.equal(basisPoints(1, 8), 1250);
  });

  it("splits 0% supplies by what was filed, not by the rate", () => {
    assert.equal(vatClass(1600), "STANDARD");
    assert.equal(vatClass(800), "REDUCED");
    assert.equal(vatClass(0), "ZERO");
    assert.equal(vatClass(0, "A"), "EXEMPT");
    assert.equal(vatClass(0, "C"), "ZERO");
  });
});
