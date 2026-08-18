import { z } from "zod";

import { forbidden, handler, notFound, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { setCompanyStatus } from "@/server/provisioning";
import { tenantDashboard } from "@/server/analytics";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>(
  { allowPlatform: true },
  async ({ principal, params }) => {
    if (principal.role !== "SUPER_ADMIN") throw forbidden();

    const company = await db.company.findUnique({
      where: { id: params.id },
      include: {
        modules: { orderBy: { moduleKey: "asc" } },
        branches: true,
        users: {
          select: {
            id: true, name: true, email: true, role: true,
            status: true, lastLoginAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { customers: true, products: true, invoices: true } },
      },
    });
    if (!company) throw notFound("Company not found");

    return {
      ...company,
      // Cross-tenant read; permitted only because the guard above restricts
      // this route to SUPER_ADMIN, and the access is audited on mutations.
      metrics: await tenantDashboard(company.id, 30),
    };
  },
);

const schema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "PENDING"]).optional(),
  name: z.string().min(2).optional(),
  seatLimit: z.number().int().min(1).max(10_000).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  taxPin: z.string().optional(),
});

export const PATCH = handler<{ id: string }>(
  { allowPlatform: true },
  async ({ principal, params, request }) => {
    if (principal.role !== "SUPER_ADMIN") throw forbidden();
    const input = await parseBody(request, schema);

    if (input.status) {
      const company = await setCompanyStatus(params.id, input.status);
      await auditAs(
        principal,
        input.status === "ACTIVE" ? "ACTIVATE" : "SUSPEND",
        "Company",
        company.id,
        { status: input.status },
        request,
      );
    }

    const { status: _status, ...rest } = input;
    const company = Object.keys(rest).length
      ? await db.company.update({ where: { id: params.id }, data: rest })
      : await db.company.findUniqueOrThrow({ where: { id: params.id } });

    if (Object.keys(rest).length) {
      await auditAs(principal, "UPDATE", "Company", company.id, rest, request);
    }

    return company;
  },
);
