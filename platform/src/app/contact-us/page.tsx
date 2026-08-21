import type { Metadata } from "next";
import Link from "next/link";

import { RautWordmark } from "@/components/raut-mark";

export const metadata: Metadata = {
  title: "Contact us",
  description:
    "Contact Raut support, or request deletion of your personal data.",
};

const SUPPORT_EMAIL = "phinetechltd@gmail.com";

/**
 * Builds a mailto: link with a prefilled subject and body.
 *
 * These are deliberately mailto rather than a form. The platform has no mail
 * transport configured, so a form would have to either drop the message or
 * queue it somewhere nobody reads — and silently losing a data-deletion request
 * is a legal problem, not just a bug. A mailto opens the sender's own client:
 * they can see it was sent, and they keep a copy.
 */
function mailto(subject: string, body: string) {
  return (
    "mailto:" +
    SUPPORT_EMAIL +
    "?subject=" +
    encodeURIComponent(subject) +
    "&body=" +
    encodeURIComponent(body)
  );
}

const SUPPORT_BODY = [
  "Describe the problem, and include these if you can:",
  "",
  "Company:",
  "Your name:",
  "Account email:",
  "Where it happened (console or mobile app):",
  "What you expected:",
  "What happened instead:",
  "",
].join("\n");

const DELETION_BODY = [
  "I am requesting deletion of personal data held in Raut.",
  "",
  "Full name:",
  "Company / employer:",
  "Email address used with Raut:",
  "Phone number used with Raut:",
  "",
  "What I want deleted (tick or delete as appropriate):",
  "  [ ] My whole account and everything linked to it",
  "  [ ] My location history only",
  "  [ ] Something else (describe below)",
  "",
  "Details:",
  "",
].join("\n");

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-surface rounded-xl border p-6 shadow-sm">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="text-content-secondary mt-3 space-y-3 text-[15px] leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function MailButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="bg-accent hover:bg-accent-hover mt-5 inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-white"
    >
      {children}
    </a>
  );
}

export default function ContactPage() {
  return (
    <main className="bg-bg min-h-screen">
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" aria-label="Raut home">
            <RautWordmark compact />
          </Link>
          <Link
            href="/login"
            className="text-accent text-sm font-medium hover:underline"
          >
            Sign in
          </Link>
        </div>
      </header>

      <article className="mx-auto max-w-3xl px-6 pb-24 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight">Contact us</h1>
        <p className="text-content-secondary mt-3 text-[15px] leading-relaxed">
          Raut is operated by Tari Africa Platforms Limited, Nairobi, Kenya.
          Everything below reaches the same inbox —{" "}
          <a className="text-accent hover:underline" href={"mailto:" + SUPPORT_EMAIL}>
            {SUPPORT_EMAIL}
          </a>{" "}
          — so if the buttons do not work on your device, write to that address
          directly.
        </p>

        <div className="mt-8 space-y-5">
          <Card title="Support">
            <p>
              Problems signing in, data that looks wrong, a sync that will not
              clear, or anything else about how the platform behaves.
            </p>
            <p>
              Telling us the company, the account email and what you were doing
              at the time is usually enough for us to find it in the audit trail.
              The button prefills those prompts.
            </p>
            <MailButton href={mailto("Raut support request", SUPPORT_BODY)}>
              Email support
            </MailButton>
          </Card>

          <Card title="Request deletion of your data">
            <p>
              You can ask us to delete personal data held about you. Use the
              button below and fill in the details it prefills, so we can find
              the right records without a round of questions.
            </p>
            <p>
              <strong>One thing to know first.</strong> Most personal data in
              Raut belongs to the business that uses it — your employer, or the
              supplier whose rep visits your shop. They are the data controller
              and we are the processor, so for their records we must forward your
              request to them and act on their instruction. We will tell you when
              we have done that. Going to them directly is usually faster.
            </p>
            <p>
              Some records cannot be deleted outright: invoices, payments and
              other accounting entries carry their own statutory retention
              period. Where that applies we will say so, and restrict the data
              instead of erasing it.
            </p>
            <MailButton href={mailto("Raut data deletion request", DELETION_BODY)}>
              Request data deletion
            </MailButton>
          </Card>

          <Card title="What happens next">
            <p>
              We acknowledge requests within 7 days and aim to resolve them
              within 30 days, which is the period the Kenyan Data Protection Act
              2019 allows. If a request is complex and we need longer, we will
              tell you why before that period is up.
            </p>
            <p>
              If you are not satisfied with how we handle it, you may complain to
              the Office of the Data Protection Commissioner of Kenya.
            </p>
            <p className="text-content-muted text-sm">
              What we collect and why is set out in the{" "}
              <Link href="/policy" className="text-accent hover:underline">
                Privacy &amp; Cookies notice
              </Link>
              .
            </p>
          </Card>
        </div>
      </article>
    </main>
  );
}
