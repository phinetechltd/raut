import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Email engine: send logging, address validation, unsubscribe suppression and
 * bulk campaigns, against a throwaway copy of the dev DB with the console
 * (non-transmitting) provider.
 */
const dir = mkdtempSync(path.join(tmpdir(), "xos-email-"));
const file = path.join(dir, "xos.db");
copyFileSync(path.resolve(__dirname, "../../prisma/xos.db"), file);
process.env.DATABASE_URL = `file:${file.split(path.sep).join("/")}`;
delete process.env.SMTP_HOST;
process.env.EMAIL_PROVIDER = "console";

type EmailServer = typeof import("./email");
type EmailLib = typeof import("@/lib/email");
type Db = typeof import("@/lib/db")["db"];
type Principal = import("@/lib/rbac").Principal;

let svc: EmailServer;
let lib: EmailLib;
let db: Db;
let admin: Principal;
let companyId: string;

const uniq = () => Math.random().toString(36).slice(2, 8);

describe("email: sending, unsubscribe and campaigns", () => {
  before(async () => {
    ({ db } = await import("@/lib/db"));
    svc = await import("./email");
    lib = await import("@/lib/email");
    const tari = await db.company.findUniqueOrThrow({ where: { slug: "tari" } });
    companyId = tari.id;
    const adminUser = await db.user.findFirstOrThrow({ where: { companyId, role: "COMPANY_ADMIN" } });
    admin = { userId: adminUser.id, companyId, role: "COMPANY_ADMIN", enabledModules: new Set(["SMS"]) };
  });

  after(async () => {
    await db.$disconnect();
  });

  it("round-trips the unsubscribe token and rejects a bad one", () => {
    const token = lib.unsubscribeToken(companyId, "a@b.com");
    assert.equal(lib.verifyUnsubscribeToken(companyId, "a@b.com", token), true);
    assert.equal(lib.verifyUnsubscribeToken(companyId, "a@b.com", "0".repeat(token.length)), false);
    assert.equal(lib.verifyUnsubscribeToken(companyId, "other@b.com", token), false);
  });

  it("logs a successful send and rejects a bad address", async () => {
    const good = await lib.queueEmail({ companyId, toEmail: `ok-${uniq()}@example.com`, subject: "Hi", html: "<p>Hi</p>" });
    assert.equal(good.status, "SENT");
    assert.equal(good.provider, "console");

    const bad = await lib.queueEmail({ companyId, toEmail: "not-an-email", subject: "Hi", html: "<p>Hi</p>" });
    assert.equal(bad.status, "FAILED");
    assert.match(bad.error ?? "", /invalid/i);
  });

  it("skips an unsubscribed address on bulk send only", async () => {
    const email = `stop-${uniq()}@example.com`;
    await db.emailUnsubscribe.create({ data: { companyId, email } });

    const bulk = await lib.queueEmail({ companyId, toEmail: email, subject: "Promo", html: "<p>Promo</p>", bulk: true });
    assert.equal(bulk.status, "SKIPPED");

    // A direct (non-bulk) message still goes — it is not marketing.
    const direct = await lib.queueEmail({ companyId, toEmail: email, subject: "Your invoice", html: "<p>Invoice</p>" });
    assert.equal(direct.status, "SENT");
  });

  it("sends a campaign to matching customers and records the counts", async () => {
    const tag = uniq();
    // Two segment-A customers with email (one unsubscribed), one segment-B.
    const a1 = await db.customer.create({ data: { companyId, code: `EC-${tag}-1`, name: "A One", segment: "A", status: "ACTIVE", email: `a1-${tag}@example.com` } });
    await db.customer.create({ data: { companyId, code: `EC-${tag}-2`, name: "A Two", segment: "A", status: "ACTIVE", email: `a2-${tag}@example.com` } });
    await db.customer.create({ data: { companyId, code: `EC-${tag}-3`, name: "B Three", segment: "B", status: "ACTIVE", email: `b3-${tag}@example.com` } });
    await db.emailUnsubscribe.create({ data: { companyId, email: `a1-${tag}@example.com` } });

    const campaign = await svc.createCampaign(admin, { name: `Seg A ${tag}`, subject: "Hello A", bodyHtml: "<p>Hello segment A</p>", segment: "A" });
    const count = await svc.campaignRecipientCount(admin, campaign.id);
    assert.ok(count >= 2, "at least our two segment-A customers are targeted");

    const sent = await svc.sendCampaign(admin, campaign.id);
    assert.equal(sent.status, "SENT");
    assert.ok(sent.sentCount >= 1);

    const msgs = await db.emailMessage.findMany({ where: { campaignId: campaign.id } });
    const toA1 = msgs.find((m) => m.toEmail === `a1-${tag}@example.com`);
    assert.equal(toA1?.status, "SKIPPED", "the unsubscribed segment-A customer was skipped");
    assert.ok(msgs.some((m) => m.toEmail === `a2-${tag}@example.com` && m.status === "SENT"));
    assert.ok(!msgs.some((m) => m.toEmail === `b3-${tag}@example.com`), "segment B was not targeted");

    await assert.rejects(svc.sendCampaign(admin, campaign.id), /already been sent/i);
  });
});
