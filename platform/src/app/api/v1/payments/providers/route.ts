import { handler } from "@/lib/api";
import { availableProviders } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * Which gateways this deployment can actually take money through.
 *
 * The mobile app calls this before showing payment methods, so a rep is never
 * offered a button that fails the instant they tap it — the fastest way for a
 * payments feature to lose a field team's trust.
 */
export const GET = handler({ permission: "payment:read" }, async () => ({
  providers: availableProviders(),
}));
