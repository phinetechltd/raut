import { z } from "zod";

import { conflict, forbidden, handler, notFound, parseBody } from "@/lib/api";
import { auditAs, diff } from "@/lib/audit";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { ROLES } from "@/lib/rbac";
import { companyIdOf, scope, hasSeatAvailable, seatUsage } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>(
  { permission: "user:read" },
  async ({ principal, params }) => {
    const user = await db.user.findFirst({
      where: { id: params.id, ...scope(principal) },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        status: true, branchId: true, lastLoginAt: true, createdAt: true,
        branch: { select: { name: true } },
        _count: { select: { visits: true, devices: true } },
      },
    });
    if (!user) throw notFound("User not found");
    return user;
  },
);

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().nullable().optional(),
  role: z.enum(ROLES).optional(),
  branchId: z.string().nullable().optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "INVITED"]).optional(),
  password: z.string().min(8).optional(),
});

export const PATCH = handler<{ id: string }>(
  { permission: "user:write" },
  async ({ principal, params, request }) => {
    const companyId = companyIdOf(principal);

    const existing = await db.user.findFirst({
      where: { id: params.id, ...scope(principal) },
    });
    if (!existing) throw notFound("User not found");

    const input = await parseBody(request, updateSchema);

    // Platform accounts only exist at platform level; a tenant admin must not
    // mint or mutate one.
    if (existing.role === "SUPER_ADMIN" || input.role === "SUPER_ADMIN") {
      throw forbidden("SUPER_ADMIN accounts are managed at platform level only");
    }

    // You cannot demote or suspend yourself out of the company admin seat.
    if (existing.id === principal.userId && (input.role && input.role !== existing.role)) {
      throw conflict("You cannot change your own role");
    }
    if (existing.id === principal.userId && input.status && input.status !== "ACTIVE") {
      throw conflict("You cannot suspend your own account");
    }

    // Reactivating counts against the seat limit exactly like inviting.
    if (input.status === "ACTIVE" && existing.status === "SUSPENDED") {
      if (!(await hasSeatAvailable(companyId))) {
        const seats = await seatUsage(companyId);
        throw conflict(
          `Seat limit reached (${seats.used}/${seats.limit}). Upgrade the licence to reactivate users.`,
        );
      }
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || key === "password") continue;
      data[key] = value === "" ? null : value;
    }
    if (input.password) {
      data.passwordHash = await hashPassword(input.password);
      // A new password should implicitly sign out the stale devices.
    }

    const user = await db.user.update({
      where: { id: params.id },
      data,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        status: true, branchId: true, lastLoginAt: true,
        branch: { select: { name: true } },
      },
    });

    await auditAs(
      principal,
      "UPDATE",
      "User",
      user.id,
      diff(existing as unknown as Record<string, unknown>, input.password ? { ...data, passwordHash: "[changed]" } : data),
      request,
    );
    return user;
  },
);
