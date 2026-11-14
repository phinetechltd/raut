import { db } from "@/lib/db";
import { verifyUnsubscribeToken } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Public one-click unsubscribe landing. The token binds the address to the
 * company, so the link in a campaign cannot be used to opt out anyone else.
 * Recording the opt-out here is what makes bulk sending lawful and auditable.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const companyId = sp.c ?? "";
  const email = (sp.e ?? "").toLowerCase();
  const token = sp.t ?? "";

  let outcome: "done" | "already" | "invalid" = "invalid";
  if (companyId && email && token && verifyUnsubscribeToken(companyId, email, token)) {
    const existing = await db.emailUnsubscribe.findUnique({
      where: { companyId_email: { companyId, email } },
      select: { id: true },
    });
    if (existing) {
      outcome = "already";
    } else {
      await db.emailUnsubscribe.create({ data: { companyId, email } }).catch(() => undefined);
      outcome = "done";
    }
  }

  const title =
    outcome === "invalid" ? "This link is not valid" : "You have been unsubscribed";
  const body =
    outcome === "invalid"
      ? "We could not verify this unsubscribe link. It may be incomplete or out of date."
      : outcome === "already"
        ? `${email} is already unsubscribed and will not receive further marketing emails.`
        : `${email} has been removed from this sender's marketing emails. You may still receive essential messages about your account, such as invoices and receipts.`;

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f6f5f2", fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <div style={{ maxWidth: 460, background: "#fff", border: "1px solid #e5e5e5", borderRadius: 14, padding: "28px 32px", textAlign: "center" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 10px", color: "#1a1a1a" }}>{title}</h1>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: "#555", margin: 0 }}>{body}</p>
      </div>
    </main>
  );
}
