import { NextResponse } from "next/server";

import { handler } from "@/lib/api";

export const dynamic = "force-dynamic";

const COPY: Record<string, { title: string; body: string; tone: string }> = {
  succeeded: {
    title: "Payment received",
    body: "Thank you. Your payment has been confirmed and recorded. You can close this page.",
    tone: "#15803d",
  },
  pending: {
    title: "Payment pending",
    body: "Your payment is still being confirmed by the provider. It will be recorded automatically once it completes — there is nothing more you need to do.",
    tone: "#b45309",
  },
  failed: {
    title: "Payment not completed",
    body: "The provider reports that this payment did not go through. No money has been taken. Please ask the person who sent you the link to try again.",
    tone: "#b91c1c",
  },
  unknown: {
    title: "Payment not found",
    body: "We could not find a payment matching this link. If you were charged, contact the business you were paying.",
    tone: "#475569",
  },
};

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * The page a payer lands on after a hosted checkout.
 *
 * Deliberately a plain HTML response from the API tree rather than a console
 * page: the payer has no Raut session and never will. It says one of four
 * things and nothing else — no amounts beyond what the link already carried,
 * no names, no links back into the application.
 */
export const GET = handler({ public: true }, async ({ searchParams }) => {
  const key = searchParams.get("s") ?? "unknown";
  const copy = COPY[key] ?? COPY.unknown;
  const ref = (searchParams.get("ref") ?? "").slice(0, 80);
  const amount = (searchParams.get("amount") ?? "").slice(0, 40);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(copy.title)}</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; display: grid; place-items: center; min-height: 100vh; }
  main { background: #fff; border-radius: 16px; box-shadow: 0 10px 30px rgba(15, 23, 42, .08); padding: 32px 28px; max-width: 420px; width: calc(100% - 32px); }
  h1 { font-size: 22px; margin: 0 0 12px; color: ${copy.tone}; }
  p { line-height: 1.5; margin: 0 0 12px; }
  dl { margin: 16px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 14px; }
  dt { color: #64748b; } dd { margin: 0; font-weight: 600; }
  footer { margin-top: 20px; font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<main>
  <h1>${escape(copy.title)}</h1>
  <p>${escape(copy.body)}</p>
  ${amount || ref ? `<dl>${amount ? `<dt>Amount</dt><dd>${escape(amount)}</dd>` : ""}${ref ? `<dt>Reference</dt><dd>${escape(ref)}</dd>` : ""}</dl>` : ""}
  <footer>Payments by Raut</footer>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
});
