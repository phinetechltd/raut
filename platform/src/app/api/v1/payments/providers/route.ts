import { handler } from "@/lib/api";
import { availableProviders } from "@/lib/payments";
import { companyIdOf } from "@/lib/tenant";
import { resolvePaymentCredentials } from "@/server/credentials";

export const dynamic = "force-dynamic";

/**
 * Which gateways *this company* can actually take money through.
 *
 * The mobile app calls this before showing payment methods, so a rep is never
 * offered a button that fails the instant they tap it — the fastest way for a
 * payments feature to lose a field team's trust. A company that has configured
 * its own Paystack sees Paystack; one that has not, does not.
 */
export const GET = handler({ permission: "payment:read" }, async ({ principal }) => {
  const creds = await resolvePaymentCredentials(companyIdOf(principal));
  return { providers: availableProviders(creds) };
});
