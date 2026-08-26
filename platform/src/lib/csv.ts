import { NextResponse } from "next/server";

/**
 * CSV for people who are going to open it in Excel.
 *
 * Two details that are easy to skip and annoying to discover later:
 *
 * A value beginning `=`, `+`, `-` or `@` is treated as a formula by Excel and
 * Sheets. A customer named "-Kariuki Stores" then executes as an expression,
 * and a crafted one can do considerably worse. Prefixing a tab neutralises it
 * while still displaying the original text.
 *
 * The BOM is what makes Excel read the file as UTF-8 rather than the system
 * codepage. Without it every accented or non-Latin name in the export arrives
 * mangled, and the fix is invisible from the code.
 */

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);

  const escaped = FORMULA_START.test(value) ? `\t${value}` : value;
  return NEEDS_QUOTING.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/** Cents as a plain decimal — no separators, so a spreadsheet reads it as a number. */
export const csvMoney = (cents: number): string => (cents / 100).toFixed(2);

export function csvResponse(filename: string, rows: (string | number | null | undefined)[][]) {
  return new NextResponse(`﻿${toCsv(rows)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
