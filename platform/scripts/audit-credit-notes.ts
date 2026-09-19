/**
 * Finds credit notes that credited less than was charged. Read-only.
 *
 * Until September 2026 a credit took the line discount off a line total that
 * already excluded it, so any return of a discounted line credited too little:
 * the customer's balance kept the difference, and the VAT reversal was short.
 * This lists every affected note with what it credited and what it should
 * have, so an accountant can raise a corrective credit note deliberately.
 *
 * It writes nothing. Issued credit notes are documents the customer holds and,
 * once eTIMS has accepted them, KRA holds too — they are corrected by a new
 * document, never rewritten.
 *
 *   npm run audit:credit-notes -- [--company <slug>]
 */
import { PrismaClient } from "@prisma/client";

import { chargedLine } from "../src/lib/money";

const db = new PrismaClient();

const args = process.argv.slice(2);
const flag = args.indexOf("--company");
const slug = flag >= 0 ? args[flag + 1] : undefined;

const fmt = (cents: number) =>
  `KES ${(cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;

async function main() {
  const companies = await db.company.findMany({
    where: slug ? { slug } : {},
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  let affectedNotes = 0;
  let totalShortfall = 0;

  for (const company of companies) {
    const lines = await db.creditNoteLine.findMany({
      where: {
        creditNote: { companyId: company.id, status: { not: "CANCELLED" } },
        invoiceLineId: { not: null },
      },
      include: {
        creditNote: {
          select: {
            id: true,
            number: true,
            issueDate: true,
            etimsStatus: true,
            customer: { select: { name: true } },
            invoice: { select: { number: true } },
          },
        },
      },
      orderBy: { creditNote: { issueDate: "asc" } },
    });
    if (lines.length === 0) continue;

    const invoiceLines = await db.invoiceLine.findMany({
      where: { id: { in: [...new Set(lines.map((l) => l.invoiceLineId!))] } },
    });
    const byId = new Map(invoiceLines.map((l) => [l.id, l]));

    // What each note should have credited: its share of what was charged for
    // the line, in proportion to the quantity it took back.
    const shortfallByNote = new Map<string, { note: (typeof lines)[number]["creditNote"]; cents: number }>();
    for (const l of lines) {
      const sold = byId.get(l.invoiceLineId!);
      if (!sold || sold.quantity <= 0) continue;
      const charged = chargedLine(sold);
      const expected = Math.round((charged.lineTotalCents * l.quantity) / sold.quantity);
      const short = expected - l.lineTotalCents;
      // A cent either way is proportional rounding, not the defect.
      if (Math.abs(short) <= 1) continue;
      const entry = shortfallByNote.get(l.creditNote.id) ?? { note: l.creditNote, cents: 0 };
      entry.cents += short;
      shortfallByNote.set(l.creditNote.id, entry);
    }

    if (shortfallByNote.size === 0) continue;

    console.log(`\n${company.name}`);
    let companyShort = 0;
    for (const { note, cents } of shortfallByNote.values()) {
      companyShort += cents;
      const filed = note.etimsStatus === "ACCEPTED" ? "  [filed with KRA]" : "";
      console.log(
        `  ${note.number}  ${note.issueDate.toISOString().slice(0, 10)}  ${note.customer.name}` +
          `  against ${note.invoice.number}: credited ${fmt(cents)} too little${filed}`,
      );
    }
    console.log(`  ${shortfallByNote.size} note(s), ${fmt(companyShort)} under-credited in total`);
    affectedNotes += shortfallByNote.size;
    totalShortfall += companyShort;
  }

  console.log(
    affectedNotes === 0
      ? "\nNo credit note credited less than was charged."
      : `\n${affectedNotes} credit note(s) under-credited by ${fmt(totalShortfall)} altogether. ` +
          "Correct each with a new credit note; notes marked [filed with KRA] also need the correction filed.",
  );
}

main()
  .catch((error) => {
    console.error("Audit failed:", error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
