import { db } from "@/lib/db";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Liveness probe. Touches the database on purpose — a process that is up but
 * cannot reach SQLite is not healthy, and reporting 200 in that state is how
 * outages get missed.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return ok({
      status: "healthy",
      service: "raut-platform",
      version: "1.0.0",
      time: new Date().toISOString(),
    });
  } catch (error) {
    return fail(
      503,
      "UNHEALTHY",
      error instanceof Error ? error.message : "Database unreachable",
    );
  }
}
