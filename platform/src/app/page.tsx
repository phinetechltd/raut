import { redirect } from "next/navigation";

import { getSessionPrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Entry point: send each principal to the console that belongs to them. */
export default async function Home() {
  const principal = await getSessionPrincipal();
  if (!principal) redirect("/login");
  redirect(principal.role === "SUPER_ADMIN" ? "/admin" : "/app");
}
