import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * CRM: pipeline seeding, lead conversion, deal win/reopen, tasks and the
 * field-rep self-scoping, against a throwaway copy of the dev database.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-crm-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Crm = typeof import("./crm");
type Db = typeof import("@/lib/db")["db"];
type Principal = import("@/lib/rbac").Principal;

let crm: Crm;
let db: Db;
let admin: Principal;
let rep: Principal;
let rep2Id: string;
let companyId: string;

const everyModule = new Set(["CRM", "SALES_POS", "FIELD_SALES"]);

const rejectsStatus = (p: Promise<unknown>, status: number, pattern?: RegExp) =>
  assert.rejects(p, (error: unknown) => {
    const e = error as { status?: number; message: string };
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

describe("crm: pipeline, leads, deals, tasks", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    crm = await import("./crm");
    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const adminUser = await db.user.findFirstOrThrow({ where: { companyId, role: "COMPANY_ADMIN" } });
    const reps = await db.user.findMany({ where: { companyId, role: "FIELD_REP" }, take: 2 });
    const repUser = reps[0]!;
    rep2Id = reps[1]?.id ?? adminUser.id;
    admin = { userId: adminUser.id, companyId, role: "COMPANY_ADMIN", enabledModules: everyModule };
    rep = { userId: repUser.id, companyId, role: "FIELD_REP", enabledModules: everyModule };
  });

  after(async () => {
    await db.$disconnect();
  });

  it("seeds the default stages once and is idempotent", async () => {
    const first = await crm.ensureStages(companyId);
    assert.equal(first.length, 6);
    assert.deepEqual(first.map((s) => s.kind).slice(-2), ["WON", "LOST"]);
    const second = await crm.ensureStages(companyId);
    assert.equal(second.length, 6, "no duplicate stages on the second call");
  });

  it("converts a lead into a customer and opens a deal, once only", async () => {
    const lead = await crm.createLead(admin, { name: "Mombasa Mini-Mart", contactName: "Asha", phone: "0722000111", source: "FIELD" });
    assert.equal(lead.status, "NEW");

    const { customer, deal } = await crm.convertLead(admin, lead.id, { createDeal: true, dealTitle: "Opening order", dealValueCents: 50_000 });
    assert.ok(customer.code.startsWith("CUST-"));
    assert.equal(customer.name, "Mombasa Mini-Mart");
    assert.ok(deal, "a deal was created");
    assert.equal(deal!.valueCents, 50_000);

    const reloaded = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    assert.equal(reloaded.status, "CONVERTED");
    assert.equal(reloaded.convertedCustomerId, customer.id);

    const contact = await db.customerContact.findFirst({ where: { customerId: customer.id } });
    assert.equal(contact?.name, "Asha", "the lead's contact carried over");

    await rejectsStatus(crm.convertLead(admin, lead.id, {}), 409, /already a customer/i);
  });

  it("moves a deal to Won and back, keeping status in step", async () => {
    const stages = await crm.ensureStages(companyId);
    const won = stages.find((s) => s.kind === "WON")!;
    const first = stages[0]!;
    const deal = await crm.createDeal(admin, { title: "Depot supply", valueCents: 120_000 });
    assert.equal(deal.status, "OPEN");

    const winner = await crm.moveDeal(admin, deal.id, won.id);
    assert.equal(winner.status, "WON");
    assert.ok(winner.wonAt, "wonAt stamped");

    const reopened = await crm.moveDeal(admin, deal.id, first.id);
    assert.equal(reopened.status, "OPEN");
    assert.equal(reopened.wonAt, null, "reopening clears wonAt");
  });

  it("groups the board by stage with value totals, open deals only", async () => {
    const board = await crm.dealBoard(admin);
    assert.equal(board.length, 6);
    const total = board.reduce((n, c) => n + c.valueCents, 0);
    assert.ok(total >= 0);
    // Won/Lost columns never carry open deals.
    const closed = board.filter((c) => c.stage.kind !== "OPEN");
    assert.ok(closed.every((c) => c.count === 0), "closed stages hold no open deals");
  });

  it("defaults a task to its creator and stamps completion", async () => {
    const task = await crm.createTask(admin, { title: "Call Asha back" });
    assert.equal(task.assignedToId, admin.userId);
    const done = await crm.updateTask(admin, task.id, { status: "DONE" });
    assert.equal(done.status, "DONE");
    assert.ok(done.completedAt, "completedAt stamped");
  });

  it("keeps a rep's deals and tasks to themselves", async () => {
    // A deal and a task owned by another rep must be invisible to this rep.
    await crm.createDeal({ ...admin, userId: rep2Id } as Principal, { title: "Someone else's deal", ownerId: rep2Id });
    await db.task.create({ data: { companyId, title: "Not yours", assignedToId: rep2Id } });

    const myDeal = await crm.createDeal(rep, { title: "My deal" });
    const myTask = await crm.createTask(rep, { title: "My task" });

    const deals = await crm.listDeals(rep);
    assert.ok(deals.every((d) => d.ownerId === rep.userId), "rep sees only their own deals");
    assert.ok(deals.some((d) => d.id === myDeal.id));

    const tasks = await crm.listTasks(rep);
    assert.ok(tasks.every((t) => t.assignedToId === rep.userId), "rep sees only their own tasks");
    assert.ok(tasks.some((t) => t.id === myTask.id));
  });
});
