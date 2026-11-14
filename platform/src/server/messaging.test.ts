import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Office ↔ field messaging: send both ways, broadcast fan-out, unread
 * watermarks and read-marking, against a throwaway copy of the dev DB.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-msg-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;

type Msg = typeof import("./messaging");
type Db = typeof import("@/lib/db")["db"];
type Principal = import("@/lib/rbac").Principal;

let m: Msg;
let db: Db;
let office: Principal;
let rep: Principal;
let companyId: string;
let repId: string;

const rejectsStatus = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: unknown) => {
    assert.equal((e as { status?: number }).status, status);
    return true;
  });

describe("messaging: office and field threads", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    m = await import("./messaging");
    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const adminUser = await db.user.findFirstOrThrow({ where: { companyId, role: "COMPANY_ADMIN" } });
    const repUser = await db.user.findFirstOrThrow({ where: { companyId, role: "FIELD_REP" } });
    repId = repUser.id;
    const mods = new Set(["FIELD_SALES"]);
    office = { userId: adminUser.id, companyId, role: "COMPANY_ADMIN", enabledModules: mods };
    rep = { userId: repId, companyId, role: "FIELD_REP", enabledModules: mods };
  });

  after(async () => {
    await db.$disconnect();
  });

  it("delivers an office message to the rep and counts it unread for the rep", async () => {
    await m.sendToRep(office, repId, "Please visit the depot today");
    assert.equal(await m.unreadCount(rep), 1, "rep has one unread");

    const inbox = await m.officeInbox(office);
    const row = inbox.find((r) => r.conversation.repId === repId);
    assert.ok(row, "the thread shows in the office inbox");
    assert.equal(row!.unread, 0, "office's own message is not unread for the office");
  });

  it("marks the rep's thread read when they open it", async () => {
    const { messages } = await m.repThread(rep);
    assert.ok(messages.length >= 1);
    assert.equal(await m.unreadCount(rep), 0, "opening the thread clears the rep's unread");
  });

  it("delivers a rep reply and counts it unread for the office", async () => {
    await m.repSend(rep, "On my way");
    assert.equal(await m.unreadCount(office), 1, "office has one unread");

    await m.officeConversation(office, repId);
    assert.equal(await m.unreadCount(office), 0, "opening the thread clears the office unread");
  });

  it("broadcasts one message into every active rep's thread", async () => {
    const reps = await db.user.count({ where: { companyId, role: "FIELD_REP", status: { not: "SUSPENDED" } } });
    const before = await db.message.count({ where: { companyId, isBroadcast: true } });
    const result = await m.broadcast(office, "Month-end push starts Monday");
    assert.equal(result.sent, reps);
    const after = await db.message.count({ where: { companyId, isBroadcast: true } });
    assert.equal(after - before, reps, "one broadcast message per rep");
  });

  it("requires the office to name a rep, and keeps threads to the right people", async () => {
    await rejectsStatus(m.sendMessage(office, { body: "to nobody" }), 409);
    // A rep's unified send always lands in their own thread.
    const sent = await m.sendMessage(rep, { body: "field note" });
    const own = await db.conversation.findUniqueOrThrow({ where: { companyId_repId: { companyId, repId } } });
    assert.equal(sent.conversationId, own.id);
  });
});
