import "server-only";

import crypto from "node:crypto";

import { conflict, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import { isSelfScoped, type Principal } from "@/lib/rbac";
import { scope } from "@/lib/tenant";

/**
 * Online meetings, held in Jitsi rooms.
 *
 * The provider is a plain URL base (JITSI_BASE, default meet.jit.si), so a room
 * is just a slug and the join link is derived — the host can move to a
 * self-hosted Jitsi without rewriting stored meetings. A customer is invited by
 * email through the existing email engine.
 */

export function meetingUrl(roomName: string): string {
  const base = (process.env.JITSI_BASE ?? "https://meet.jit.si").replace(/\/$/, "");
  return `${base}/${encodeURIComponent(roomName)}`;
}

function newRoomName(slug: string): string {
  return `raut-${slug}-${crypto.randomBytes(5).toString("hex")}`;
}

function meetingScope(principal: Principal): Record<string, unknown> {
  const where = scope(principal);
  // A rep sees the meetings they host; the office sees all of the company's.
  if (isSelfScoped(principal)) where.hostId = principal.userId;
  return where;
}

export interface MeetingInput {
  title: string;
  customerId?: string | null;
  scheduledAt: string;
  durationMin?: number;
  notes?: string | null;
}

export async function listMeetings(principal: Principal, opts: { scope?: "upcoming" | "past" | "all" } = {}) {
  const where: Record<string, unknown> = meetingScope(principal);
  const now = new Date();
  if (opts.scope === "upcoming") {
    where.scheduledAt = { gte: now };
    where.status = "SCHEDULED";
  } else if (opts.scope === "past") {
    where.OR = [{ scheduledAt: { lt: now } }, { status: { in: ["DONE", "CANCELLED"] } }];
  }
  return db.meeting.findMany({
    where,
    include: { customer: { select: { id: true, name: true, email: true } } },
    orderBy: { scheduledAt: opts.scope === "past" ? "desc" : "asc" },
    take: 500,
  });
}

export async function createMeeting(principal: Principal, input: MeetingInput) {
  const companyId = principal.companyId!;
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { slug: true } });
  if (input.customerId) {
    const c = await db.customer.findFirst({ where: { id: input.customerId, companyId }, select: { id: true } });
    if (!c) throw notFound("Customer not found");
  }
  return db.meeting.create({
    data: {
      companyId,
      customerId: input.customerId ?? null,
      title: input.title,
      scheduledAt: new Date(input.scheduledAt),
      durationMin: input.durationMin ?? 30,
      roomName: newRoomName(company.slug),
      notes: input.notes ?? null,
      hostId: principal.userId,
      createdById: principal.userId,
    },
    include: { customer: { select: { id: true, name: true, email: true } } },
  });
}

export async function updateMeeting(principal: Principal, id: string, input: Partial<MeetingInput> & { status?: string }) {
  const existing = await db.meeting.findFirst({ where: { id, ...meetingScope(principal) }, select: { id: true } });
  if (!existing) throw notFound("Meeting not found");
  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.customerId !== undefined) data.customerId = input.customerId;
  if (input.scheduledAt !== undefined) data.scheduledAt = new Date(input.scheduledAt);
  if (input.durationMin !== undefined) data.durationMin = input.durationMin;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.status !== undefined) data.status = input.status;
  return db.meeting.update({ where: { id }, data });
}

/** Emails the customer the meeting details and a join link. */
export async function inviteCustomer(principal: Principal, id: string) {
  const companyId = principal.companyId!;
  const meeting = await db.meeting.findFirst({
    where: { id, ...meetingScope(principal) },
    include: { customer: { select: { id: true, name: true, email: true } } },
  });
  if (!meeting) throw notFound("Meeting not found");
  if (meeting.status !== "SCHEDULED") throw conflict("Only a scheduled meeting can be sent an invite");
  if (!meeting.customer?.email) throw conflict("This meeting has no customer with an email address");

  const url = meetingUrl(meeting.roomName);
  const when = meeting.scheduledAt.toLocaleString("en-KE", { dateStyle: "full", timeStyle: "short" });
  const html = `
    <p>Hello ${meeting.customer.name},</p>
    <p>You are invited to an online meeting: <strong>${meeting.title}</strong>.</p>
    <p><strong>When:</strong> ${when} (${meeting.durationMin} minutes)</p>
    <p><strong>Join here:</strong> <a href="${url}">${url}</a></p>
    <p>No app or account is needed — the link opens in your browser.</p>`;

  return queueEmail({
    companyId,
    customerId: meeting.customerId,
    toEmail: meeting.customer.email,
    subject: `Meeting invitation: ${meeting.title}`,
    html,
  });
}
