import { z } from "zod";

import { conflict, handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { ROLES } from "@/lib/rbac";
import { companyIdOf, hasSeatAvailable, scope, seatUsage } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(
  { permission: "user:read" },
  async ({ principal, searchParams }) => {
    const companyId = companyIdOf(principal);

    const users = await db.user.findMany({
      where: {
        ...scope(principal),
        ...(searchParams.get("role") ? { role: searchParams.get("role")! } : {}),
      },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        status: true, branchId: true, lastLoginAt: true, createdAt: true,
        branch: { select: { name: true } },
        _count: { select: { visits: true, devices: true } },
      },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    });

    return ok(users, { seats: await seatUsage(companyId) });
  },
);

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional(),
  role: z.enum(ROLES),
  branchId: z.string().optional(),
});

export const POST = handler(
  { permission: "user:write" },
  async ({ principal, request }) => {
    const companyId = companyIdOf(principal);
    const input = await parseBody(request, schema);

    // The licence sold to Raut covers up to 50 users (proposal §7). Enforcing
    // it here is what makes the seat count a real limit and not a brochure line.
    if (!(await hasSeatAvailable(companyId))) {
      const seats = await seatUsage(companyId);
      throw conflict(
        `Seat limit reached (${seats.used}/${seats.limit}). Upgrade the licence to add users.`,
      );
    }

    // A company admin must not be able to mint a platform-level account.
    if (input.role === "SUPER_ADMIN") {
      throw conflict("SUPER_ADMIN accounts are created at platform level only");
    }

    const user = await db.user.create({
      data: {
        companyId,
        branchId: input.branchId ?? null,
        name: input.name,
        email: input.email.toLowerCase(),
        phone: input.phone ?? null,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      },
      select: {
        id: true, name: true, email: true, role: true, status: true, branchId: true,
      },
    });

    await auditAs(principal, "CREATE", "User", user.id, {
      email: user.email,
      role: user.role,
    }, request);

    return ok(user, undefined, { status: 201 });
  },
);
