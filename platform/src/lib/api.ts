import "server-only";

import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";

import { getPrincipal } from "./auth";
import { db } from "./db";
import { MODULE_CATALOG, isModuleKey, type ModuleKey } from "./modules";
import {
  can,
  denialReason,
  moduleNameFor,
  type Permission,
  type Principal,
} from "./rbac";

/**
 * Shared plumbing for /api/v1 route handlers.
 *
 * Every mobile-facing endpoint funnels through `handler()`, which resolves the
 * principal, checks the permission (role AND module licence), and turns thrown
 * errors into a consistent envelope. The Flutter client can therefore rely on
 * one response shape for every call.
 */

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export function ok<T>(
  data: T,
  meta?: Record<string, unknown>,
  init?: ResponseInit,
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ ok: true, data, ...(meta ? { meta } : {}) }, init);
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse<ApiFailure> {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (m: string, d?: unknown) =>
  new ApiError(400, "BAD_REQUEST", m, d);
export const notFound = (m = "Not found") => new ApiError(404, "NOT_FOUND", m);
export const conflict = (m: string) => new ApiError(409, "CONFLICT", m);
export const forbidden = (m = "Forbidden") => new ApiError(403, "FORBIDDEN", m);

export interface HandlerContext<P = Record<string, string>> {
  principal: Principal;
  request: Request;
  params: P;
  searchParams: URLSearchParams;
}

export interface HandlerOptions {
  /** Permission required to reach the handler. Omit for authenticated-only. */
  permission?: Permission;
  /** Extra module licence requirement beyond the permission's own module. */
  module?: ModuleKey;
  /** Allow SUPER_ADMIN (no companyId). Defaults to false for tenant routes. */
  allowPlatform?: boolean;
  /** Skip auth entirely — only for /auth/login and /health. */
  public?: boolean;
}

// Next 15 types route handlers as (request, context) with a required context
// carrying a params promise, so this must not be optional or the generated
// .next/types check fails. It is still read defensively below.
type RouteArgs<P> = { params: Promise<P> };

/**
 * Wraps a route handler with auth, authorization and error normalisation.
 */
export function handler<P extends Record<string, string> = Record<string, string>, R = unknown>(
  options: HandlerOptions,
  fn: (ctx: HandlerContext<P>) => Promise<R | NextResponse>,
) {
  return async (request: Request, args: RouteArgs<P>): Promise<NextResponse> => {
    try {
      const params = ((await args?.params) ?? {}) as P;
      const searchParams = new URL(request.url).searchParams;

      if (options.public) {
        const result = await fn({
          principal: undefined as unknown as Principal,
          request,
          params,
          searchParams,
        });
        return result instanceof NextResponse ? result : ok(result);
      }

      const principal = await getPrincipal(request);
      if (!principal) {
        return fail(401, "UNAUTHENTICATED", "Sign in to continue");
      }

      if (!principal.companyId && !options.allowPlatform) {
        return fail(
          403,
          "TENANT_REQUIRED",
          "This endpoint operates inside a company. Choose a company first.",
        );
      }

      if (options.permission && !can(principal, options.permission)) {
        const reason = denialReason(principal, options.permission);
        if (reason === "module") {
          const name = moduleNameFor(options.permission);
          return fail(
            402,
            "MODULE_NOT_LICENSED",
            `${name ?? "This module"} is not part of your subscription.`,
            { module: name },
          );
        }
        return fail(
          403,
          "FORBIDDEN",
          "Your role does not permit this action.",
          { permission: options.permission },
        );
      }

      if (
        options.module &&
        principal.role !== "SUPER_ADMIN" &&
        !principal.enabledModules.has(options.module)
      ) {
        return fail(
          402,
          "MODULE_NOT_LICENSED",
          `${MODULE_CATALOG[options.module].name} is not part of your subscription.`,
          { module: MODULE_CATALOG[options.module].name },
        );
      }

      const result = await fn({ principal, request, params, searchParams });
      return result instanceof NextResponse ? result : ok(result);
    } catch (error) {
      return normaliseError(error);
    }
  };
}

function normaliseError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return fail(error.status, error.code, error.message, error.details);
  }
  if (error instanceof ZodError) {
    return fail(422, "VALIDATION_FAILED", "Request payload is invalid", {
      issues: error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const message = error instanceof Error ? error.message : String(error);

  // Prisma unique-constraint violations are a client problem, not a 500.
  if (message.includes("Unique constraint failed")) {
    return fail(409, "CONFLICT", "A record with these details already exists");
  }
  if (message.includes("Foreign key constraint")) {
    return fail(400, "BAD_REFERENCE", "A referenced record does not exist");
  }

  console.error("[api] unhandled", error);
  return fail(500, "INTERNAL_ERROR", "Something went wrong on our side");
}

// ── request parsing ────────────────────────────────────────────────────

export async function parseBody<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  return schema.parse(raw);
}

export function parseQuery<T>(
  searchParams: URLSearchParams,
  schema: ZodSchema<T>,
): T {
  return schema.parse(Object.fromEntries(searchParams.entries()));
}

export interface Page {
  take: number;
  skip: number;
  page: number;
}

export function pagination(searchParams: URLSearchParams, defaultTake = 50): Page {
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
  const take = Math.min(
    200,
    Math.max(1, Number(searchParams.get("limit") ?? defaultTake) || defaultTake),
  );
  return { take, skip: (page - 1) * take, page };
}

export function paginationMeta(page: Page, total: number) {
  return {
    page: page.page,
    limit: page.take,
    total,
    pages: Math.max(1, Math.ceil(total / page.take)),
  };
}

// ── idempotency (mobile writes) ────────────────────────────────────────

/**
 * Replays a previous response for a repeated client UUID.
 *
 * The field app retries pushes it never saw a reply to. Without this, a rep in
 * a low-signal market posts one order and the server records two. The key is
 * the client-generated UUID, scoped per user, so two reps cannot collide.
 */
export async function withIdempotency<T>(
  principal: Principal,
  key: string | null | undefined,
  endpoint: string,
  work: () => Promise<T>,
): Promise<{ data: T; replayed: boolean }> {
  if (!key) return { data: await work(), replayed: false };

  const existing = await db.idempotencyKey.findUnique({ where: { key } });
  if (existing) {
    if (existing.userId !== principal.userId) {
      throw conflict("Idempotency key already used by another user");
    }
    return { data: JSON.parse(existing.response) as T, replayed: true };
  }

  const data = await work();

  await db.idempotencyKey
    .create({
      data: {
        key,
        userId: principal.userId,
        endpoint,
        response: JSON.stringify(data),
        entityType: endpoint,
        entityId:
          data && typeof data === "object" && "id" in data
            ? String((data as { id: unknown }).id)
            : null,
      },
    })
    // A racing duplicate lost the insert; the work already succeeded once.
    .catch(() => undefined);

  return { data, replayed: false };
}

// ── misc ───────────────────────────────────────────────────────────────

export function moduleKeyOrThrow(value: string): ModuleKey {
  if (!isModuleKey(value)) throw badRequest(`Unknown module "${value}"`);
  return value;
}

/** ISO date parsing that rejects rather than silently producing Invalid Date. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date: ${value}`);
  return d;
}
