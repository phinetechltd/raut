"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Keeps the live-tracking section current without the user pressing reload.
 *
 * Every 45 seconds it asks the API for the latest positions and, if the
 * answer differs from the last one, refreshes the server-rendered page so the
 * map and the table redraw from the same query the page already runs. The
 * fetch is the cheap change-detector; the page render is the source of truth.
 * Paused while the tab is hidden — a dozen managers with the console open in
 * a background tab should not poll a server all afternoon.
 */
export function LiveRefresh({ intervalMs = 45_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let signature: string | null = null;

    async function tick() {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/v1/location/latest", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as {
          ok: boolean;
          data?: { asOf: string; positions: Array<{ userId: string; recordedAt: string }> };
        };
        if (!json.ok || !json.data || cancelled) return;
        const next = json.data.positions.map((p) => `${p.userId}@${p.recordedAt}`).sort().join("|");
        setLastSeen(new Date(json.data.asOf).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" }));
        if (signature !== null && next !== signature) router.refresh();
        signature = next;
      } catch {
        // Offline or the server is restarting; the next tick tries again.
      }
    }

    void tick();
    const timer = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, intervalMs]);

  return (
    <span role="status" className="text-content-muted inline-flex items-center gap-1.5 text-xs">
      <span className="bg-success inline-block h-1.5 w-1.5 animate-pulse rounded-full" aria-hidden="true" />
      Live · refreshes every {Math.round(intervalMs / 1000)} s{lastSeen ? ` · checked ${lastSeen}` : ""}
    </span>
  );
}
