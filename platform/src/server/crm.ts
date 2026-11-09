import "server-only";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { conflict, notFound } from "@/lib/api";
import type { Principal } from "@/lib/rbac";
import { isSelfScoped } from "@/lib/rbac";
import { scope } from "@/lib/tenant";

/**
 * CRM: leads, a sales pipeline (stages + deals) and tasks.
 *
 * Customers, their contacts and the activity log already exist (Module 01);
 * this adds the top of the funnel (leads), the opportunity pipeline and a
 * shared task list. Field reps are self-scoped — they see the deals and tasks
 * that are theirs — exactly as visits and orders already are.
 */

// ── pipeline stages ──────────────────────────────────────────────────────

const DEFAULT_STAGES: Array<{ name: string; kind: "OPEN" | "WON" | "LOST" }> = [
  { name: "New", kind: "OPEN" },
  { name: "Qualified", kind: "OPEN" },
  { name: "Proposal", kind: "OPEN" },
  { name: "Negotiation", kind: "OPEN" },
  { name: "Won", kind: "WON" },
  { name: "Lost", kind: "LOST" },
];

/** Returns the company's stages, seeding the defaults the first time. */
export async function ensureStages(companyId: string) {
  const existing = await db.pipelineStage.findMany({
    where: { companyId },
    orderBy: { sortOrder: "asc" },
  });
  if (existing.length > 0) return existing;

  await db.pipelineStage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({ companyId, name: s.name, kind: s.kind, sortOrder: i })),
  });
  return db.pipelineStage.findMany({ where: { companyId }, orderBy: { sortOrder: "asc" } });
}

// ── leads ────────────────────────────────────────────────────────────────

export interface LeadInput {
  name: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  source?: string | null;
  status?: string;
  ownerId?: string | null;
  notes?: string | null;
}

export async function listLeads(principal: Principal, opts: { status?: string; q?: string } = {}) {
  const where: Record<string, unknown> = scope(principal, { selfField: "ownerId" });
  if (opts.status) where.status = opts.status;
  if (opts.q) {
    where.OR = [
      { name: { contains: opts.q } },
      { contactName: { contains: opts.q } },
      { phone: { contains: opts.q } },
      { email: { contains: opts.q } },
    ];
  }
  return db.lead.findMany({ where, orderBy: { updatedAt: "desc" }, take: 500 });
}

export async function createLead(principal: Principal, input: LeadInput) {
  return db.lead.create({
    data: {
      companyId: principal.companyId!,
      name: input.name,
      contactName: input.contactName ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      source: input.source ?? null,
      status: input.status ?? "NEW",
      // A rep's new lead is theirs to work unless a manager assigns it on.
      ownerId: input.ownerId ?? (isSelfScoped(principal) ? principal.userId : null),
      notes: input.notes ?? null,
      createdById: principal.userId,
    },
  });
}

export async function updateLead(principal: Principal, id: string, input: Partial<LeadInput>) {
  const existing = await db.lead.findFirst({ where: { id, ...scope(principal, { selfField: "ownerId" }) } });
  if (!existing) throw notFound("Lead not found");
  if (existing.status === "CONVERTED") throw conflict("A converted lead can no longer be edited");

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) data[k] = v;
  return db.lead.update({ where: { id }, data });
}

/**
 * Turns a lead into a customer. Creates the Customer, marks the lead CONVERTED
 * and links the two, and optionally opens a first deal — all in one transaction
 * so a half-converted lead can never exist.
 */
export async function convertLead(
  principal: Principal,
  id: string,
  opts: { createDeal?: boolean; dealTitle?: string; dealValueCents?: number } = {},
) {
  const companyId = principal.companyId!;
  const lead = await db.lead.findFirst({ where: { id, ...scope(principal, { selfField: "ownerId" }) } });
  if (!lead) throw notFound("Lead not found");
  if (lead.status === "CONVERTED") throw conflict("This lead is already a customer");

  return db.$transaction(async (tx) => {
    // A short unique customer code: CUST-#### by count, nudged on collision.
    const n = await tx.customer.count({ where: { companyId } });
    let code = `CUST-${String(n + 1).padStart(4, "0")}`;
    if (await tx.customer.findFirst({ where: { companyId, code } })) code = `CUST-${lead.id.slice(-6)}`;

    const customer = await tx.customer.create({
      data: {
        companyId,
        code,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        assignedRepId: lead.ownerId,
        createdById: principal.userId,
        notes: lead.notes,
      },
    });

    if (lead.contactName) {
      await tx.customerContact.create({
        data: { companyId, customerId: customer.id, name: lead.contactName, phone: lead.phone, email: lead.email, isPrimary: true },
      });
    }

    await tx.lead.update({ where: { id }, data: { status: "CONVERTED", convertedCustomerId: customer.id } });

    let deal = null;
    if (opts.createDeal) {
      const stages = await ensureStagesTx(tx, companyId);
      deal = await tx.deal.create({
        data: {
          companyId,
          customerId: customer.id,
          leadId: lead.id,
          stageId: stages[0]!.id,
          title: opts.dealTitle?.trim() || `${lead.name} opportunity`,
          valueCents: opts.dealValueCents ?? 0,
          ownerId: lead.ownerId,
          createdById: principal.userId,
        },
      });
    }

    await tx.customerActivity.create({
      data: {
        companyId,
        customerId: customer.id,
        userId: principal.userId,
        type: "NOTE",
        subject: "Converted from lead",
        body: lead.source ? `Lead source: ${lead.source}` : null,
      },
    });

    return { customer, deal };
  }, { timeout: 15_000 });
}

async function ensureStagesTx(tx: Prisma.TransactionClient, companyId: string) {
  const existing = await tx.pipelineStage.findMany({ where: { companyId }, orderBy: { sortOrder: "asc" } });
  if (existing.length > 0) return existing;
  await tx.pipelineStage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({ companyId, name: s.name, kind: s.kind, sortOrder: i })),
  });
  return tx.pipelineStage.findMany({ where: { companyId }, orderBy: { sortOrder: "asc" } });
}

// ── deals ──────────────────────────────────────────────────────────────────

export interface DealInput {
  title: string;
  customerId?: string | null;
  leadId?: string | null;
  stageId?: string;
  valueCents?: number;
  probability?: number | null;
  expectedCloseAt?: string | null;
  ownerId?: string | null;
}

export async function listDeals(
  principal: Principal,
  opts: { status?: string; stageId?: string; customerId?: string } = {},
) {
  const where: Record<string, unknown> = scope(principal, { selfField: "ownerId" });
  if (opts.status) where.status = opts.status;
  if (opts.stageId) where.stageId = opts.stageId;
  if (opts.customerId) where.customerId = opts.customerId;
  return db.deal.findMany({
    where,
    include: { stage: true, customer: { select: { id: true, name: true, code: true } } },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
}

/** The pipeline grouped by stage, with per-stage count and value — the board. */
export async function dealBoard(principal: Principal) {
  const companyId = principal.companyId!;
  const stages = await ensureStages(companyId);
  const deals = await listDeals(principal, { status: "OPEN" });
  const byStage = new Map<string, typeof deals>();
  for (const d of deals) {
    const list = byStage.get(d.stageId) ?? [];
    list.push(d);
    byStage.set(d.stageId, list);
  }
  return stages.map((stage) => {
    const items = byStage.get(stage.id) ?? [];
    return {
      stage,
      deals: items,
      count: items.length,
      valueCents: items.reduce((sum, d) => sum + d.valueCents, 0),
    };
  });
}

export async function createDeal(principal: Principal, input: DealInput) {
  const companyId = principal.companyId!;
  const stages = await ensureStages(companyId);
  const stageId = input.stageId ?? stages[0]!.id;
  if (!stages.some((s) => s.id === stageId)) throw notFound("Pipeline stage not found");
  if (input.customerId) {
    const c = await db.customer.findFirst({ where: { id: input.customerId, companyId } });
    if (!c) throw notFound("Customer not found");
  }
  return db.deal.create({
    data: {
      companyId,
      title: input.title,
      customerId: input.customerId ?? null,
      leadId: input.leadId ?? null,
      stageId,
      valueCents: input.valueCents ?? 0,
      probability: input.probability ?? null,
      expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null,
      ownerId: input.ownerId ?? (isSelfScoped(principal) ? principal.userId : null),
      createdById: principal.userId,
    },
    include: { stage: true },
  });
}

export async function updateDeal(principal: Principal, id: string, input: Partial<DealInput>) {
  const companyId = principal.companyId!;
  const existing = await db.deal.findFirst({ where: { id, ...scope(principal, { selfField: "ownerId" }) } });
  if (!existing) throw notFound("Deal not found");

  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.customerId !== undefined) data.customerId = input.customerId;
  if (input.valueCents !== undefined) data.valueCents = input.valueCents;
  if (input.probability !== undefined) data.probability = input.probability;
  if (input.ownerId !== undefined) data.ownerId = input.ownerId;
  if (input.expectedCloseAt !== undefined)
    data.expectedCloseAt = input.expectedCloseAt ? new Date(input.expectedCloseAt) : null;
  return db.deal.update({ where: { id }, data, include: { stage: true } });
}

/**
 * Moves a deal to a stage, keeping status in step: landing on a WON or LOST
 * stage closes the deal and stamps the time; moving back to an OPEN stage
 * reopens it. This is the one place deal status changes, so win-rate numbers
 * stay trustworthy.
 */
export async function moveDeal(principal: Principal, id: string, stageId: string, lostReason?: string) {
  const companyId = principal.companyId!;
  const existing = await db.deal.findFirst({ where: { id, ...scope(principal, { selfField: "ownerId" }) } });
  if (!existing) throw notFound("Deal not found");
  const stage = await db.pipelineStage.findFirst({ where: { id: stageId, companyId } });
  if (!stage) throw notFound("Pipeline stage not found");

  const data: Record<string, unknown> = { stageId, status: stage.kind };
  data.wonAt = stage.kind === "WON" ? new Date() : null;
  data.lostAt = stage.kind === "LOST" ? new Date() : null;
  data.lostReason = stage.kind === "LOST" ? lostReason ?? existing.lostReason ?? null : null;

  const deal = await db.deal.update({ where: { id }, data, include: { stage: true } });

  if (stage.kind === "WON" && existing.customerId) {
    await db.customerActivity.create({
      data: {
        companyId,
        customerId: existing.customerId,
        userId: principal.userId,
        type: "NOTE",
        subject: `Deal won: ${existing.title}`,
      },
    });
  }
  return deal;
}

// ── tasks ────────────────────────────────────────────────────────────────

export interface TaskInput {
  title: string;
  description?: string | null;
  dueAt?: string | null;
  priority?: string;
  assignedToId?: string | null;
  customerId?: string | null;
  dealId?: string | null;
  leadId?: string | null;
}

export async function listTasks(
  principal: Principal,
  opts: { status?: string; mine?: boolean; customerId?: string; dealId?: string } = {},
) {
  // Reps only ever see tasks assigned to them; managers can ask for "mine".
  const where: Record<string, unknown> = scope(principal);
  if (isSelfScoped(principal)) where.assignedToId = principal.userId;
  else if (opts.mine) where.assignedToId = principal.userId;
  if (opts.status) where.status = opts.status;
  if (opts.customerId) where.customerId = opts.customerId;
  if (opts.dealId) where.dealId = opts.dealId;
  return db.task.findMany({
    where,
    include: { customer: { select: { id: true, name: true, code: true } } },
    orderBy: [{ status: "asc" }, { dueAt: "asc" }],
    take: 500,
  });
}

export async function createTask(principal: Principal, input: TaskInput) {
  return db.task.create({
    data: {
      companyId: principal.companyId!,
      title: input.title,
      description: input.description ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      priority: input.priority ?? "NORMAL",
      // Unassigned defaults to the creator, so nothing is dropped on the floor.
      assignedToId: input.assignedToId ?? principal.userId,
      customerId: input.customerId ?? null,
      dealId: input.dealId ?? null,
      leadId: input.leadId ?? null,
      createdById: principal.userId,
    },
    include: { customer: { select: { id: true, name: true, code: true } } },
  });
}

export async function updateTask(principal: Principal, id: string, input: Partial<TaskInput> & { status?: string }) {
  const existing = await db.task.findFirst({ where: { id, ...scope(principal) } });
  if (!existing) throw notFound("Task not found");
  // A rep may only touch their own task.
  if (isSelfScoped(principal) && existing.assignedToId !== principal.userId) throw notFound("Task not found");

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (k === "dueAt") data.dueAt = v ? new Date(v as string) : null;
    else data[k] = v;
  }
  if (input.status === "DONE" && existing.status !== "DONE") data.completedAt = new Date();
  if (input.status && input.status !== "DONE") data.completedAt = null;
  return db.task.update({ where: { id }, data });
}

// ── dashboard ──────────────────────────────────────────────────────────────

export async function crmDashboard(principal: Principal) {
  const companyId = principal.companyId!;
  const board = await dealBoard(principal);
  const openValueCents = board.reduce((sum, col) => sum + col.valueCents, 0);
  const openCount = board.reduce((sum, col) => sum + col.count, 0);

  const dealScope = scope(principal, { selfField: "ownerId" });
  const [won, lost] = await Promise.all([
    db.deal.count({ where: { ...dealScope, status: "WON" } }),
    db.deal.count({ where: { ...dealScope, status: "LOST" } }),
  ]);
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;

  const taskScope: Record<string, unknown> = scope(principal);
  if (isSelfScoped(principal)) taskScope.assignedToId = principal.userId;
  const now = new Date();
  const [openTasks, overdueTasks, newLeads] = await Promise.all([
    db.task.count({ where: { ...taskScope, status: "OPEN" } }),
    db.task.count({ where: { ...taskScope, status: "OPEN", dueAt: { lt: now } } }),
    db.lead.count({ where: { ...scope(principal, { selfField: "ownerId" }), status: { in: ["NEW", "WORKING"] } } }),
  ]);

  return { board, openValueCents, openCount, won, lost, winRate, openTasks, overdueTasks, newLeads };
}
