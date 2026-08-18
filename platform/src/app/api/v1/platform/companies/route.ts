import { z } from "zod";

import { forbidden, handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import { MODULE_KEYS } from "@/lib/modules";
import { createCompany, slugify } from "@/server/provisioning";

export const dynamic = "force-dynamic";

/** Every route in /platform is Super Admin only. */
function assertPlatform(role: string) {
  if (role !== "SUPER_ADMIN") throw forbidden("Platform administration requires SUPER_ADMIN");
}

export const GET = handler(
  { allowPlatform: true },
  async ({ principal, searchParams }) => {
    assertPlatform(principal.role);

    const search = searchParams.get("q");
    const companies = await db.company.findMany({
      where: {
        ...(search
          ? { OR: [{ name: { contains: search } }, { slug: { contains: search } }] }
          : {}),
        ...(searchParams.get("status") ? { status: searchParams.get("status")! } : {}),
      },
      include: {
        _count: { select: { users: true, customers: true, branches: true } },
        modules: { where: { enabled: true }, select: { moduleKey: true, priceCents: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return companies.map((c) => ({
      ...c,
      moduleCount: c.modules.length,
      moduleValueCents: c.modules.reduce((sum, m) => sum + m.priceCents, 0),
    }));
  },
);

const schema = z.object({
  name: z.string().min(2),
  slug: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  taxPin: z.string().optional(),
  seatLimit: z.number().int().min(1).max(10_000).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  modules: z.array(z.enum(MODULE_KEYS)).optional(),
  activate: z.boolean().optional(),
  admin: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    phone: z.string().optional(),
  }),
});

/** "Create & activate companies" — Phase One Super Admin deliverable. */
export const POST = handler(
  { allowPlatform: true },
  async ({ principal, request }) => {
    assertPlatform(principal.role);
    const input = await parseBody(request, schema);

    const company = await createCompany({
      ...input,
      slug: input.slug ? slugify(input.slug) : slugify(input.name),
    });

    await auditAs(principal, "CREATE", "Company", company.id, {
      name: company.name,
      modules: input.modules ?? [],
    }, request);

    return ok(company, undefined, { status: 201 });
  },
);
