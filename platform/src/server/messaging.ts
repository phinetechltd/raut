import "server-only";

import { conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { isSelfScoped, type Principal } from "@/lib/rbac";

/**
 * Office ↔ field messaging.
 *
 * One conversation per rep: every office manager shares the office side, the
 * rep owns the other. Read state is a per-side watermark (officeLastReadAt /
 * repLastReadAt), so "unread" is simply messages from the other side newer than
 * your watermark. A broadcast is one message fanned out to every rep's thread.
 */

async function ensureConversation(companyId: string, repId: string) {
  return db.conversation.upsert({
    where: { companyId_repId: { companyId, repId } },
    create: { companyId, repId },
    update: {},
  });
}

async function assertRep(companyId: string, repId: string) {
  const rep = await db.user.findFirst({ where: { id: repId, companyId, role: "FIELD_REP" }, select: { id: true } });
  if (!rep) throw notFound("Field rep not found");
}

// ── office side ──────────────────────────────────────────────────────────

/** One row per rep conversation, with a preview and the office's unread count. */
export async function officeInbox(principal: Principal) {
  const companyId = principal.companyId!;
  const convos = await db.conversation.findMany({ where: { companyId }, orderBy: { lastMessageAt: "desc" }, take: 500 });
  const reps = await db.user.findMany({ where: { id: { in: convos.map((c) => c.repId) } }, select: { id: true, name: true } });
  const nameOf = new Map(reps.map((r) => [r.id, r.name]));

  return Promise.all(
    convos.map(async (c) => {
      const [last, unread] = await Promise.all([
        db.message.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: "desc" } }),
        db.message.count({ where: { conversationId: c.id, senderId: c.repId, createdAt: { gt: c.officeLastReadAt ?? new Date(0) } } }),
      ]);
      return { conversation: c, repName: nameOf.get(c.repId) ?? "Unknown rep", last, unread };
    }),
  );
}

/** The thread with one rep, marking it read for the office. */
export async function officeConversation(principal: Principal, repId: string) {
  const companyId = principal.companyId!;
  await assertRep(companyId, repId);
  const conversation = await ensureConversation(companyId, repId);
  const messages = await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, take: 500 });
  await db.conversation.update({ where: { id: conversation.id }, data: { officeLastReadAt: new Date() } });
  const rep = await db.user.findUnique({ where: { id: repId }, select: { name: true } });
  return { conversation, repName: rep?.name ?? "Unknown rep", messages };
}

export async function sendToRep(principal: Principal, repId: string, body: string) {
  const companyId = principal.companyId!;
  if (!body.trim()) throw conflict("A message cannot be empty");
  await assertRep(companyId, repId);
  const conversation = await ensureConversation(companyId, repId);
  const now = new Date();
  const [message] = await Promise.all([
    db.message.create({ data: { companyId, conversationId: conversation.id, senderId: principal.userId, body: body.trim() } }),
    db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, officeLastReadAt: now } }),
  ]);
  return message;
}

/** One message to every active rep's thread. */
export async function broadcast(principal: Principal, body: string) {
  const companyId = principal.companyId!;
  if (!body.trim()) throw conflict("A message cannot be empty");
  const reps = await db.user.findMany({ where: { companyId, role: "FIELD_REP", status: { not: "SUSPENDED" } }, select: { id: true } });
  const now = new Date();
  let sent = 0;
  for (const rep of reps) {
    const conversation = await ensureConversation(companyId, rep.id);
    await db.message.create({ data: { companyId, conversationId: conversation.id, senderId: principal.userId, body: body.trim(), isBroadcast: true } });
    await db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, officeLastReadAt: now } });
    sent += 1;
  }
  return { sent };
}

// ── rep side (self) ────────────────────────────────────────────────────────

/** The rep's own conversation with the office, marked read for the rep. */
export async function repThread(principal: Principal) {
  const companyId = principal.companyId!;
  const conversation = await ensureConversation(companyId, principal.userId);
  const messages = await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, take: 500 });
  await db.conversation.update({ where: { id: conversation.id }, data: { repLastReadAt: new Date() } });
  return { conversation, messages };
}

export async function repSend(principal: Principal, body: string) {
  if (!body.trim()) throw conflict("A message cannot be empty");
  return repSendRaw(principal.companyId!, principal.userId, body);
}

/**
 * A rep posts to their own thread, by raw ids. Used by the offline sync drain,
 * which has the company and user ids but not a full principal.
 */
export async function repSendRaw(companyId: string, userId: string, body: string) {
  const conversation = await ensureConversation(companyId, userId);
  const now = new Date();
  const message = await db.message.create({
    data: { companyId, conversationId: conversation.id, senderId: userId, body: body.trim() },
  });
  await db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, repLastReadAt: now } });
  return message;
}

/** Unread for whichever side the principal is on. */
export async function unreadCount(principal: Principal): Promise<number> {
  const companyId = principal.companyId!;
  if (isSelfScoped(principal)) {
    const c = await db.conversation.findUnique({ where: { companyId_repId: { companyId, repId: principal.userId } } });
    if (!c) return 0;
    return db.message.count({ where: { conversationId: c.id, senderId: { not: principal.userId }, createdAt: { gt: c.repLastReadAt ?? new Date(0) } } });
  }
  // Office: messages from reps newer than each thread's office watermark.
  const convos = await db.conversation.findMany({ where: { companyId } });
  let total = 0;
  for (const c of convos) {
    total += await db.message.count({ where: { conversationId: c.id, senderId: c.repId, createdAt: { gt: c.officeLastReadAt ?? new Date(0) } } });
  }
  return total;
}

/** Unified send: a rep posts to their own thread; the office must name a rep. */
export async function sendMessage(principal: Principal, input: { repId?: string | null; body: string }) {
  if (isSelfScoped(principal)) return repSend(principal, input.body);
  if (!input.repId) throw conflict("Choose a rep to message");
  return sendToRep(principal, input.repId, input.body);
}
