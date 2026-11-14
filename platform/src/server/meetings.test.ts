import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Online meetings: room creation, the derived Jitsi URL, email invites and
 * cancellation, against a throwaway copy of the dev DB (console email provider).
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-meet-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;
delete process.env.SMTP_HOST;
process.env.EMAIL_PROVIDER = "console";
process.env.JITSI_BASE = "https://meet.jit.si";

type Meet = typeof import("./meetings");
type Db = typeof import("@/lib/db")["db"];
type Principal = import("@/lib/rbac").Principal;

let mt: Meet;
let db: Db;
let admin: Principal;
let companyId: string;

const soon = () => new Date(Date.now() + 3600_000).toISOString();
const rejectsStatus = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: unknown) => {
    assert.equal((e as { status?: number }).status, status);
    return true;
  });

describe("meetings: rooms, invites and cancellation", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    mt = await import("./meetings");
    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const adminUser = await db.user.findFirstOrThrow({ where: { companyId, role: "COMPANY_ADMIN" } });
    admin = { userId: adminUser.id, companyId, role: "COMPANY_ADMIN", enabledModules: new Set(["CRM", "SMS"]) };
  });

  after(async () => {
    await db.$disconnect();
  });

  it("creates a Jitsi room and derives its join URL", async () => {
    const m = await mt.createMeeting(admin, { title: "Demo call", scheduledAt: soon(), durationMin: 45 });
    assert.ok(m.roomName.startsWith("raut-tari-"), m.roomName);
    assert.equal(m.status, "SCHEDULED");
    assert.equal(m.durationMin, 45);
    assert.equal(mt.meetingUrl(m.roomName), `https://meet.jit.si/${m.roomName}`);
  });

  it("rejects an unknown customer", async () => {
    await rejectsStatus(mt.createMeeting(admin, { title: "x", scheduledAt: soon(), customerId: "nope" }), 404);
  });

  it("emails an invite when the customer has an address, else refuses", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const withEmail = await db.customer.create({ data: { companyId, code: `MT-${tag}-1`, name: "Mettable", status: "ACTIVE", email: `m-${tag}@example.com` } });
    const noEmail = await db.customer.create({ data: { companyId, code: `MT-${tag}-2`, name: "No Mail", status: "ACTIVE" } });

    const m1 = await mt.createMeeting(admin, { title: "Review", scheduledAt: soon(), customerId: withEmail.id });
    const sent = await mt.inviteCustomer(admin, m1.id);
    assert.equal(sent.status, "SENT");
    assert.match(sent.bodyHtml, /meet\.jit\.si/);

    const m2 = await mt.createMeeting(admin, { title: "Review", scheduledAt: soon(), customerId: noEmail.id });
    await rejectsStatus(mt.inviteCustomer(admin, m2.id), 409);
  });

  it("cancels a meeting and drops it from the upcoming list", async () => {
    const m = await mt.createMeeting(admin, { title: "To cancel", scheduledAt: soon() });
    await mt.updateMeeting(admin, m.id, { status: "CANCELLED" });
    const upcoming = await mt.listMeetings(admin, { scope: "upcoming" });
    assert.ok(!upcoming.some((x) => x.id === m.id), "cancelled meeting is not upcoming");
    const past = await mt.listMeetings(admin, { scope: "past" });
    assert.ok(past.some((x) => x.id === m.id), "it shows under past & cancelled");
  });
});
