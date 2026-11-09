import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Sales targets: creation, the commission formula and achievement wiring,
 * against a throwaway copy of the dev database.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-targets-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Targets = typeof import("./targets");
type Db = typeof import("@/lib/db")["db"];
type Principal = import("@/lib/rbac").Principal;

let t: Targets;
let db: Db;
let admin: Principal;
let companyId: string;
let repId: string;

const rejectsStatus = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: unknown) => {
    assert.equal((e as { status?: number }).status, status);
    return true;
  });

describe("targets: creation, commission and achievement", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    t = await import("./targets");
    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const adminUser = await db.user.findFirstOrThrow({ where: { companyId, role: "COMPANY_ADMIN" } });
    admin = { userId: adminUser.id, companyId, role: "COMPANY_ADMIN", enabledModules: new Set(["FIELD_SALES"]) };
    const rep = await db.user.findFirstOrThrow({ where: { companyId, role: "FIELD_REP" } });
    repId = rep.id;
  });

  after(async () => {
    await db.$disconnect();
  });

  it("rejects a period that ends before it starts", async () => {
    await rejectsStatus(
      t.createTarget(admin, { repId, periodStart: "2026-02-01", periodEnd: "2026-01-01" }),
      409,
    );
  });

  it("creates a target and computes commission as a share of sales achieved", async () => {
    await t.createTarget(admin, {
      repId,
      period: "MONTHLY",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      targetSalesCents: 1_000_000,
      targetCollectionCents: 500_000,
      targetVisits: 20,
      commissionRateBp: 250, // 2.5%
    });

    const rows = await t.targetAchievement(admin);
    const row = rows.find((r) => r.target.repId === repId && r.target.targetSalesCents === 1_000_000);
    assert.ok(row, "the new target appears in achievement");
    // Commission is exactly 2.5% of whatever sales the books show for the rep.
    assert.equal(row!.commissionCents, Math.round((row!.actual.salesCents * 250) / 10_000));
    // Progress is actual/target as a percentage, or null when no target is set.
    assert.equal(row!.progress.sales, row!.target.targetSalesCents > 0 ? Math.round((row!.actual.salesCents / row!.target.targetSalesCents) * 100) : null);
    assert.equal(row!.progress.newCustomers, null, "no new-customer target set → null, not a divide by zero");
  });

  it("updates and removes a target", async () => {
    const created = await t.createTarget(admin, { repId, periodStart: "2026-03-01", periodEnd: "2026-03-31", commissionRateBp: 100 });
    const updated = await t.updateTarget(admin, created.id, { commissionRateBp: 500 });
    assert.equal(updated.commissionRateBp, 500);
    await t.deleteTarget(admin, created.id);
    const gone = await db.salesTarget.findUnique({ where: { id: created.id } });
    assert.equal(gone, null);
  });

  it("limits the current view to targets whose window spans today", async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const active = await t.createTarget(admin, { repId, periodStart: start, periodEnd: end, targetSalesCents: 42 });
    const current = await t.targetAchievement(admin, { current: true });
    assert.ok(current.some((r) => r.target.id === active.id), "today's target is in the current view");
    assert.ok(current.every((r) => r.target.periodStart <= now && r.target.periodEnd >= now), "only current targets");
  });
});
