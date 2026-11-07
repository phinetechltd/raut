/**
 * How long a write waits for the database, in seconds.
 *
 * SQLite has one writer. Prisma's default wait is 5 seconds, after which the
 * second writer fails with P1008 and the user sees an error for a request that
 * only needed to queue. Longer than any transaction's own 15 to 20 second limit,
 * so that limit decides first.
 */
const LOCK_WAIT_SECONDS = 30;

/** Adds the wait to a SQLite address. Anything else, or a wait already set, is left alone. */
export function withLockWait(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file:") || /[?&]socket_timeout=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}socket_timeout=${LOCK_WAIT_SECONDS}`;
}

/** Prisma's codes for "the database was too busy", where trying again is the right answer. */
const BUSY_CODES = new Set(["P1008", "P2024", "P2028", "P2034"]);

export function isDatabaseBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && BUSY_CODES.has(code);
}
