"use server";

import { revalidatePath } from "next/cache";

import { audit, auditAs } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  MAP_PROVIDER_LABELS,
  isPlausibleGoogleApiKey,
  isPlausibleGoogleMapId,
  normaliseProvider,
  resolveMapConfig,
} from "@/lib/maps";
import { isModuleKey, MODULE_CATALOG } from "@/lib/modules";
import { requireSuperAdmin } from "@/lib/session";
import { platformMapDefaults, readStoredMapSettings, saveMapSettings } from "@/server/maps";
import { createCompany, setCompanyStatus, setModule, slugify } from "@/server/provisioning";

/** Server actions backing the Super Admin console. Each re-asserts the guard. */

export interface ActionState {
  error?: string;
  success?: string;
}

/**
 * Which basemap a tenant's console and field app use. The company's own admin
 * can set this under Settings → Maps; the platform operator can do it here
 * for them, typically while onboarding, or to put a company on Google Maps
 * using the platform's shared key.
 */
export async function setMapSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { principal } = await requireSuperAdmin();

  const companyId = String(formData.get("companyId") ?? "");
  const providerRaw = String(formData.get("provider") ?? "").trim();
  const provider = providerRaw === "" ? null : normaliseProvider(providerRaw);
  if (providerRaw !== "" && !provider) return { error: "Unknown map provider" };

  const apiKey = String(formData.get("googleApiKey") ?? "").trim();
  const removeKey = formData.get("removeKey") === "on";
  const mapId = String(formData.get("googleMapId") ?? "").trim();

  if (apiKey && !isPlausibleGoogleApiKey(apiKey)) {
    return { error: "That does not look like a Google Maps browser key (AIza…, 39 characters)" };
  }
  if (mapId && !isPlausibleGoogleMapId(mapId)) {
    return { error: "That does not look like a Google Map ID" };
  }

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true },
  });
  if (!company) return { error: "Unknown company" };

  if (provider === "GOOGLE") {
    const current = await readStoredMapSettings(companyId);
    const after = resolveMapConfig(
      {
        provider: "GOOGLE",
        googleApiKey: removeKey ? null : apiKey || current.googleApiKey,
        googleMapId: mapId || current.googleMapId,
      },
      platformMapDefaults(),
    );
    if (!after.google) {
      return {
        error:
          "Google Maps needs an API key. Enter one for this company, or set GOOGLE_MAPS_API_KEY on the server.",
      };
    }
  }

  await saveMapSettings(companyId, {
    provider,
    googleApiKey: removeKey ? null : apiKey || undefined,
    googleMapId: mapId || null,
  });

  // Recorded against the tenant, not the operator's (absent) company, so the
  // change shows in that company's own activity log. Never the key itself.
  await audit({
    companyId,
    userId: principal.userId,
    action: "UPDATE",
    entity: "Setting",
    entityId: "maps",
    changes: {
      provider: provider ?? "platform-default",
      googleApiKey: removeKey ? "removed" : apiKey ? "replaced" : "unchanged",
      googleMapId: mapId ? "set" : "removed",
      by: "super-admin",
    },
  });

  revalidatePath(`/admin/companies/${companyId}`);

  return {
    success: `${company.name} now uses ${
      provider ? MAP_PROVIDER_LABELS[provider] : "the platform default map"
    }`,
  };
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
