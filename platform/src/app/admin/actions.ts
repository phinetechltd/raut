"use server";

import { revalidatePath } from "next/cache";

import { auditAs } from "@/lib/audit";
import { isModuleKey, MODULE_CATALOG } from "@/lib/modules";
import { requireSuperAdmin } from "@/lib/session";
import { createCompany, setCompanyStatus, setModule, slugify } from "@/server/provisioning";

/** Server actions backing the Super Admin console. Each re-asserts the guard. */

export interface ActionState {
  error?: string;
  success?: string;
}

export async function toggleModuleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { principal } = await requireSuperAdmin();

  const companyId = String(formData.get("companyId") ?? "");
  const moduleKey = String(formData.get("moduleKey") ?? "");
  const enabled = formData.get("enabled") === "true";

  if (!companyId || !isModuleKey(moduleKey)) {
    return { error: "Unknown company or module" };
  }

  const licence = await setModule(companyId, moduleKey, enabled);
  await auditAs(
    principal,
    enabled ? "MODULE_ENABLE" : "MODULE_DISABLE",
    "CompanyModule",
    licence.id,
    { companyId, moduleKey },
  );

  revalidatePath(`/admin/companies/${companyId}`);
  revalidatePath("/admin");

  return {
    success: `${MODULE_CATALOG[moduleKey].name} ${enabled ? "enabled" : "disabled"}`,
  };
}

export async function setStatusAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { principal } = await requireSuperAdmin();

  const companyId = String(formData.get("companyId") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!["ACTIVE", "SUSPENDED", "PENDING"].includes(status)) {
    return { error: "Invalid status" };
  }

  const company = await setCompanyStatus(companyId, status);
  await auditAs(
    principal,
    status === "ACTIVE" ? "ACTIVATE" : "SUSPEND",
    "Company",
    company.id,
    { status },
  );

  revalidatePath(`/admin/companies/${companyId}`);
  revalidatePath("/admin/companies");

  return { success: `${company.name} is now ${status.toLowerCase()}` };
}

export async function createCompanyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { principal } = await requireSuperAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const adminName = String(formData.get("adminName") ?? "").trim();
  const adminEmail = String(formData.get("adminEmail") ?? "").trim().toLowerCase();
  const adminPassword = String(formData.get("adminPassword") ?? "");

  if (!name || !adminName || !adminEmail) {
    return { error: "Company name and administrator details are required" };
  }
  if (adminPassword.length < 8) {
    return { error: "Administrator password must be at least 8 characters" };
  }

  const modules = formData
    .getAll("modules")
    .map(String)
    .filter(isModuleKey);

  try {
    const company = await createCompany({
      name,
      slug: slugify(String(formData.get("slug") || name)),
      email: String(formData.get("email") ?? "") || null,
      phone: String(formData.get("phone") ?? "") || null,
      address: String(formData.get("address") ?? "") || null,
      taxPin: String(formData.get("taxPin") ?? "") || null,
      seatLimit: Number(formData.get("seatLimit") ?? 50) || 50,
      modules,
      activate: true,
      admin: {
        name: adminName,
        email: adminEmail,
        password: adminPassword,
        phone: String(formData.get("adminPhone") ?? "") || null,
      },
    });

    await auditAs(principal, "CREATE", "Company", company.id, { name, modules });

    revalidatePath("/admin/companies");
    revalidatePath("/admin");

    return { success: `${company.name} created with ${modules.length} module(s)` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create company";
    if (message.includes("Unique constraint")) {
      return { error: "A company with that slug, or a user with that email, already exists" };
    }
    return { error: message };
  }
}
