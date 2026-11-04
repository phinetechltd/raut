import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Document numbering against a throwaway copy of the dev database.
 *
 * The copy is made and DATABASE_URL pointed at it *before* the modules are
 * imported: `@/lib/db` builds its PrismaClient at import time from that
 * variable, and nothing here may touch prisma/xos.db itself.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-numbering-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Numbering = typeof import("./numbering");
type Db = typeof import("./db");

let numbering: Numbering;
let db: Db["db"];
let companyId: string;

const suffix = (n: string) => Number(n.split("-").pop());

describe("nextNumber", () => {
  before(async () => {
    numbering = await import("./numbering");
    ({ db } = await import("./db"));
    const company = await db.company.create({
      data: { name: "Numbering Test Co", slug: `numbering-${Date.now()}`, status: "ACTIVE" },
    });
    companyId = company.id;
  });

  after(async () => {
    await db.$disconnect();
  });

  it("starts a fresh counter at -0001 and advances it by exactly one each call", async () => {
    const first = await numbering.nextNumber(companyId, "INVOICE");
    const second = await numbering.nextNumber(companyId, "INVOICE");
    const third = await numbering.nextNumber(companyId, "INVOICE");
    assert.equal(first, "INV-0001");
    assert.equal(second, "INV-0002");
    assert.equal(third, "INV-0003");

    const counter = await db.documentCounter.findUniqueOrThrow({
      where: { companyId_docType: { companyId, docType: "INVOICE" } },
    });
    assert.equal(counter.nextValue, 4, "the counter is one ahead of the last number issued");
  });

  it("is an atomic increment: concurrent callers never share a number", async () => {
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () => numbering.nextNumber(companyId, "PAYMENT")),
    );
    const unique = new Set(numbers);
    assert.equal(unique.size, numbers.length, `duplicates in ${numbers.join(", ")}`);

    const values = numbers.map(suffix).sort((a, b) => a - b);
    assert.deepEqual(values, Array.from({ length: 12 }, (_, i) => i + 1), "no gaps either");
  });

  it("leaves no gaps inside a transaction and rolls the counter back with it", async () => {
    await numbering.nextNumber(companyId, "ORDER"); // SO-0001, committed

    await assert.rejects(
      db.$transaction(async (tx) => {
        const a = await numbering.nextNumber(companyId, "ORDER", tx);
        const b = await numbering.nextNumber(companyId, "ORDER", tx);
        assert.equal(suffix(b), suffix(a) + 1, "consecutive inside the transaction");
        throw new Error("abort");
      }),
      /abort/,
    );

    // The two numbers taken inside the aborted transaction were never issued,
    // so the next caller gets the one after the last committed number.
    const next = await numbering.nextNumber(companyId, "ORDER");
    assert.equal(next, "SO-0002");
  });

  it("survives concurrent first-callers on a counter that does not exist yet", async () => {
    // Nobody has numbered an expense for this company. Several callers race to
    // create the counter; exactly one may win, the rest must take the
    // increment path rather than each believing they issued -0001.
    const numbers = await Promise.all(
      Array.from({ length: 6 }, () => numbering.nextNumber(companyId, "EXPENSE")),
    );
    assert.equal(new Set(numbers).size, numbers.length, `duplicates in ${numbers.join(", ")}`);
    assert.ok(numbers.includes("EXP-0001"));

    const counters = await db.documentCounter.findMany({ where: { companyId, docType: "EXPENSE" } });
    assert.equal(counters.length, 1, "only one counter row exists");
    assert.equal(counters[0].nextValue, 7);
  });

  it("formats with the counter's own prefix and padding", () => {
    assert.equal(numbering.formatDocumentNumber("ZM-PO", 7), "ZM-PO-0007");
    assert.equal(numbering.formatDocumentNumber("INV", 12345), "INV-12345");
  });
});
