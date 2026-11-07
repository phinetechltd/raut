import { PrismaClient } from "@prisma/client";

import { withLockWait } from "./db-url";

// Next dev reloads modules on every edit; without the global cache each reload
// opens a new SQLite connection pool and the process eventually runs out.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const url = withLockWait(process.env.DATABASE_URL);

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(url ? { datasources: { db: { url } } } : {}),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
