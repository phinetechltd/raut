import { redirect } from "next/navigation";

import { Landing } from "@/components/landing";
import { getSessionPrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Entry point.
 *
 * A signed-in principal goes straight to the console that belongs to them —
 * making someone who is already authenticated read a marketing page to get to
 * their work would be daft. Everyone else gets the landing page.
 */
export default async function Home() {
  const principal = await getSessionPrincipal();
  if (principal) {
    redirect(principal.role === "SUPER_ADMIN" ? "/admin" : "/app");
  }
  return <Landing />;
}
