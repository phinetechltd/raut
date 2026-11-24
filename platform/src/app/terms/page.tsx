import type { Metadata } from "next";
import Link from "next/link";

import { RautWordmark } from "@/components/raut-mark";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms governing use of the Raut ERP and field-sales platform, operated by Tari Africa Platforms Limited.",
};

/** Last substantive revision. Bump this when the terms below change. */
const UPDATED = "23 November 2026";

const CONTENTS: Array<[string, string]> = [
  ["acceptance", "Acceptance of these terms"],
  ["service", "The service"],
  ["accounts", "Accounts and eligibility"],
  ["acceptable-use", "Acceptable use"],
  ["your-data", "Your data and ownership"],
  ["fees", "Trials, fees and subscriptions"],
  ["availability", "Availability and support"],
  ["liability", "Warranties and liability"],
  ["termination", "Suspension and termination"],
  ["governing-law", "Governing law"],
  ["changes", "Changes to these terms"],
  ["contact", "Contact"],
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mt-12 text-xl font-semibold tracking-tight">{title}</h2>
      <div className="text-content-secondary mt-3 space-y-3 text-[15px] leading-relaxed">
        {children}
      </div>
    </section>
  );
}

/**
 * Public Terms of Service.
 *
 * Written to describe how Raut is actually sold and run — a multi-tenant SaaS
 * where each customer company controls its own data — rather than a generic
 * template. It is a plain-language agreement, not legal advice; Tari Africa
 * Platforms should have counsel review it before relying on it commercially.
 */
export default function TermsPage() {
  return (
    <main className="bg-bg min-h-screen">
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" aria-label="Raut home">
            <RautWordmark compact />
          </Link>
          <Link href="/login" className="text-accent text-sm font-medium hover:underline">
            Sign in
          </Link>
        </div>
      </header>

      <article className="mx-auto max-w-3xl px-6 pb-24 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="text-content-muted mt-2 text-sm">Last updated {UPDATED}</p>

        <p className="text-content-secondary mt-6 text-[15px] leading-relaxed">
          These Terms of Service (the &ldquo;Terms&rdquo;) are an agreement
          between you and <strong>Tari Africa Platforms Limited</strong>
          (&ldquo;Tari Africa&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), the
          operator of Raut, a multi-tenant ERP and field-sales platform
          (&ldquo;Raut&rdquo; or the &ldquo;service&rdquo;). By creating an
          account or using Raut you agree to these Terms. If you are agreeing on
          behalf of a company, you confirm you are authorised to bind that
          company, and &ldquo;you&rdquo; means that company.
        </p>

        <nav
          aria-label="Contents"
          className="border-border bg-surface mt-8 rounded-lg border p-4"
        >
          <p className="text-content-muted text-xs font-semibold uppercase tracking-wide">
            On this page
          </p>
          <ol className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
            {CONTENTS.map(([id, label]) => (
              <li key={id}>
                <a href={"#" + id} className="text-accent hover:underline">
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <Section id="acceptance" title="Acceptance of these terms">
          <p>
            By creating a workspace, signing in, or otherwise using Raut, you
            accept these Terms and our{" "}
            <Link href="/policy" className="text-accent hover:underline">
              Privacy &amp; Cookies notice
            </Link>
            . If you do not agree, do not use the service.
          </p>
        </Section>

        <Section id="service" title="The service">
          <p>
            Raut provides, through a web console and a companion mobile app,
            tools for customer management, sales, quotations and invoicing, stock
            and procurement, finance and reporting, field-sales visits, routing,
            messaging and tax-invoice features, licensed by module. The features
            available to you depend on the modules enabled on your workspace.
          </p>
          <p>
            We may add, change or remove features over time. Where a change
            materially reduces core functionality you rely on, we will make
            reasonable efforts to tell you in advance.
          </p>
        </Section>

        <Section id="accounts" title="Accounts and eligibility">
          <p>
            You must provide accurate signup details and keep them current. Each
            workspace has an administrator who manages its users; you are
            responsible for all activity under your workspace and for the users
            you invite.
          </p>
          <p>
            Keep your credentials confidential. You are responsible for securing
            your password and devices, and for telling us promptly if you suspect
            unauthorised access. We recommend a strong, unique password.
          </p>
        </Section>

        <Section id="acceptable-use" title="Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>use Raut for anything unlawful, or to store or send unlawful content;</li>
            <li>
              attempt to access another company&apos;s data, break the service&apos;s
              tenant isolation, or probe, scan or test its security without our
              written permission;
            </li>
            <li>
              interfere with or disrupt the service, or circumvent usage,
              licensing or rate limits;
            </li>
            <li>
              resell, sublicense or offer the service to third parties except as
              expressly agreed; or
            </li>
            <li>
              upload malware, or use the messaging and SMS features to send spam
              or content recipients have not consented to receive.
            </li>
          </ul>
          <p>
            You are responsible for complying with the laws that apply to your
            own business, including tax, consumer, data-protection and marketing
            rules.
          </p>
        </Section>

        <Section id="your-data" title="Your data and ownership">
          <p>
            The data you and your users put into Raut — your customers, orders,
            invoices, stock, staff and related records (&ldquo;your data&rdquo;)
            — remains yours. For that data your company is the data controller
            and Tari Africa is the data processor, acting on your instructions, as
            described in the{" "}
            <Link href="/policy" className="text-accent hover:underline">
              Privacy &amp; Cookies notice
            </Link>
            .
          </p>
          <p>
            You grant us the limited rights needed to host, process, back up and
            display your data in order to provide the service. You can export
            your data from the console while your subscription is active. We do
            not sell your data and do not use it for advertising.
          </p>
        </Section>

        <Section id="fees" title="Trials, fees and subscriptions">
          <p>
            Raut may be offered on a free trial and on paid subscriptions priced
            by module or seat. Trial workspaces may have limits and may be
            suspended or removed after the trial period. Paid fees, billing
            cycle and any taxes are those set out in your order or the pricing
            presented to you when you subscribe.
          </p>
          <p>
            Unless stated otherwise, fees are payable in advance and are
            non-refundable except where required by law. We may change pricing on
            reasonable notice, effective from your next billing cycle.
          </p>
        </Section>

        <Section id="availability" title="Availability and support">
          <p>
            We aim to keep Raut available and reliable, and the mobile app is
            built to keep working offline and sync when a connection returns.
            However, the service is provided on an &ldquo;as available&rdquo;
            basis and may be interrupted for maintenance, updates or causes
            outside our control. We are not a bank, payment provider or tax
            authority; where Raut connects to such third parties, their own terms
            and availability also apply.
          </p>
        </Section>

        <Section id="liability" title="Warranties and liability">
          <p>
            To the fullest extent permitted by law, Raut is provided without
            warranties of any kind, express or implied, including fitness for a
            particular purpose. We do not warrant that the service will be
            uninterrupted or error-free, or that any calculation, tax filing or
            report will meet every legal requirement applicable to your business
            — you remain responsible for checking your own records and filings.
          </p>
          <p>
            To the fullest extent permitted by law, neither party is liable for
            indirect, incidental or consequential losses, or for lost profits,
            revenue or data; and our total liability arising out of or relating
            to the service will not exceed the fees you paid for the service in
            the twelve months before the event giving rise to the claim. Nothing
            in these Terms excludes liability that cannot be excluded by law.
          </p>
        </Section>

        <Section id="termination" title="Suspension and termination">
          <p>
            You may stop using Raut and close your workspace at any time. We may
            suspend or terminate access if you breach these Terms, fail to pay
            fees due, or use the service in a way that risks harm to others or to
            the platform.
          </p>
          <p>
            After termination we may delete your data after a reasonable period;
            export anything you need to keep beforehand. Terms that by their
            nature should survive — including data ownership, fees already due,
            and limitation of liability — continue after termination.
          </p>
        </Section>

        <Section id="governing-law" title="Governing law">
          <p>
            These Terms are governed by the laws of the Republic of Kenya, and
            the courts of Kenya have exclusive jurisdiction over any dispute,
            without prejudice to any mandatory consumer protections available to
            you.
          </p>
        </Section>

        <Section id="changes" title="Changes to these terms">
          <p>
            We may update these Terms from time to time. When we make material
            changes we will update the date above and, where appropriate, notify
            workspace administrators. Continuing to use Raut after a change takes
            effect means you accept the updated Terms.
          </p>
        </Section>

        <Section id="contact" title="Contact">
          <p>
            Questions about these Terms can be sent to Tari Africa Platforms
            Limited via our{" "}
            <Link href="/contact-us" className="text-accent hover:underline">
              contact page
            </Link>
            .
          </p>
        </Section>
      </article>
    </main>
  );
}
