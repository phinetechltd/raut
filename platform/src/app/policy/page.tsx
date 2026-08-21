import type { Metadata } from "next";
import Link from "next/link";

import { RautWordmark } from "@/components/raut-mark";

export const metadata: Metadata = {
  title: "Privacy & Cookies",
  description:
    "How Raut collects, uses and stores personal data, and the cookies the platform sets.",
};

/** Last substantive revision. Bump this when the practices below change. */
const UPDATED = "21 August 2026";

const CONTENTS: Array<[string, string]> = [
  ["what-we-collect", "What we collect"],
  ["location", "Location data"],
  ["cookies", "Cookies and local storage"],
  ["how-we-use-it", "How it is used"],
  ["sharing", "Who it is shared with"],
  ["retention", "How long it is kept"],
  ["security", "Security"],
  ["your-rights", "Your rights"],
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

/** Three-column table. Wide content scrolls inside its own box, not the page. */
function DataTable({
  caption,
  rows,
}: {
  caption: string;
  rows: Array<[string, string, string]>;
}) {
  return (
    <div className="border-border mt-4 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              What
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              Specifically
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              Why
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([what, detail, why]) => (
            <tr key={what} className="border-border border-t align-top">
              <td className="px-4 py-3 font-medium">{what}</td>
              <td className="text-content-secondary px-4 py-3">{detail}</td>
              <td className="text-content-secondary px-4 py-3">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Public privacy and cookies notice.
 *
 * Deliberately describes what this system actually does — one session cookie,
 * no analytics, location only on check-in unless tracking is switched on —
 * rather than the generic superset a template would claim. An inaccurate
 * privacy notice is worse than none: it is a statement customers rely on.
 */
export default function PolicyPage() {
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
        <h1 className="text-3xl font-semibold tracking-tight">
          Privacy &amp; Cookies
        </h1>
        <p className="text-content-muted mt-2 text-sm">
          Last updated {UPDATED}
        </p>

        <p className="text-content-secondary mt-6 text-[15px] leading-relaxed">
          Raut is a multi-tenant ERP and field-sales platform operated by Tari
          Africa Platforms Limited. Businesses use it to run their own sales
          operations, so most of the personal data in Raut is entered by those
          businesses about their own staff and trade customers.
        </p>
        <p className="text-content-secondary mt-3 text-[15px] leading-relaxed">
          For that data the customer company is the <strong>data controller</strong>{" "}
          and Tari Africa Platforms is the <strong>data processor</strong>: we
          hold and process it on their instructions. If you are a field rep, or a
          shop whose details appear in Raut, your first point of contact is the
          business you deal with.
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

        <Section id="what-we-collect" title="What we collect">
          <p>
            Raut collects what the platform needs to do its job, and no more.
            There is no advertising, no profiling and no third-party analytics:
            the console loads no external scripts, trackers or fonts.
          </p>
          <DataTable
            caption="Categories of personal data Raut stores"
            rows={[
              [
                "Account",
                "Name, work email, phone number, role, the company and branch you belong to, and a hashed password.",
                "To sign you in, and to decide what you are allowed to see.",
              ],
              [
                "Device",
                "A device identifier, platform, model, app version, and when the device last synced.",
                "So a lost handset can be cut off without disturbing anyone else.",
              ],
              [
                "Trade customer records",
                "Shop name, contact phone and email, physical address and town, GPS pin, credit limit, outstanding balance and free-text notes.",
                "Entered by the customer company to run its sales, credit and delivery operations.",
              ],
              [
                "Visits and sales",
                "Scheduled, check-in and check-out times, the GPS position at check-in, the geofence verdict, orders, payments, invoices and expense claims.",
                "The operational record of the work performed.",
              ],
              [
                "Photos",
                "Images captured during a visit, and the time they were taken.",
                "Proof of delivery, shelf condition, or a disputed order.",
              ],
              [
                "Audit log",
                "Who did what, to which record, when — with the IP address and the browser or app user agent of the request.",
                "Accountability, and investigating disputes or misuse.",
              ],
            ]}
          />
        </Section>

        <Section id="location" title="Location data">
          <p>
            Location is the most sensitive thing Raut handles, so it is worth
            being precise about it.
          </p>
          <p>
            <strong>At check-in.</strong> When a field rep checks in at a
            customer, the app records the GPS position at that moment, and the
            server compares it against the customer&rsquo;s stored pin or the
            territory boundary. The verdict — verified or not, and the distance —
            is stored on the visit. This happens only when the rep taps check-in.
          </p>
          <p>
            <strong>Continuous tracking is off by default.</strong> A rep may
            switch on route tracking, which records periodic points: position,
            accuracy, speed, heading, battery level, and whether the device is
            moving. The app states plainly whether tracking is on. While it is
            off, no background positions are recorded.
          </p>
          <p>
            Location is used to verify that field work happened where it was
            reported, and to sequence routes by distance. It is never sold, and
            never shared outside the company that employs the rep.
          </p>
        </Section>

        <Section id="cookies" title="Cookies and local storage">
          <p>
            Raut sets <strong>one cookie</strong>, and it is strictly necessary.
            There are no advertising or analytics cookies, which is why the
            platform shows no consent banner: there is nothing optional to
            consent to. Refusing the session cookie simply means you cannot sign
            in.
          </p>
          <DataTable
            caption="Cookies and browser storage used by Raut"
            rows={[
              [
                "raut_session",
                "Cookie. HTTP-only and same-site, so page scripts cannot read it. Holds your signed session.",
                "Strictly necessary — it is what keeps you signed in. Cleared when you sign out.",
              ],
              [
                "raut.theme",
                "Browser local storage, not a cookie. Stores your light, dark or system preference.",
                "Remembers how you like the console to look. Contains no personal data.",
              ],
              [
                "App token storage",
                "Mobile app only: access and refresh tokens, the device id and the last-sync time, in the app's private storage on the device.",
                "Keeps you signed in between shifts, and lets the app work with no signal. Removed when you sign out.",
              ],
            ]}
          />
        </Section>

        <Section id="how-we-use-it" title="How it is used">
          <p>
            To operate the service you or your employer signed up for: signing
            people in, enforcing what each role may see, recording sales and
            visits, verifying field activity, and keeping an audit trail. We also
            use it to keep the service secure and to diagnose faults.
          </p>
          <p>
            We do not use your data to train models, build advertising profiles,
            or sell to anyone.
          </p>
        </Section>

        <Section id="sharing" title="Who it is shared with">
          <p>
            <strong>Between companies, never.</strong> Raut is multi-tenant:
            every record carries the company it belongs to, and that scope is
            derived from your signed-in session rather than from anything the
            browser or app sends. One company cannot read or write
            another&rsquo;s data.
          </p>
          <p>
            Within your company, access depends on your role and on which modules
            the company licenses. Data leaves the platform only where we are
            legally required to disclose it, or to the infrastructure provider
            hosting the service on our behalf.
          </p>
          <p>
            The platform runs on a virtual private server in Europe. Where the
            SMS module is enabled, message content and recipient numbers are
            passed to the SMS provider your company configures.
          </p>
        </Section>

        <Section id="retention" title="How long it is kept">
          <p>
            Operational records — customers, visits, orders, invoices, payments —
            are kept for as long as the customer company keeps its account. They
            are that company&rsquo;s business records, and usually carry their own
            statutory retention period under tax law.
          </p>
          <p>
            We do not currently run automated deletion of location history or
            audit logs; they are retained until the account is closed. If your
            company needs a defined schedule — discarding location points after 90
            days, for instance — contact us and we will configure it.
          </p>
        </Section>

        <Section id="security" title="Security">
          <p>
            Traffic is encrypted in transit with TLS. Passwords are stored hashed,
            never in readable form. Sessions use short-lived access tokens with
            rotating, device-bound refresh tokens, so a stolen token has a narrow
            window and a replayed one is refused outright.
          </p>
          <p>
            No system is perfectly secure. If you believe an account or a record
            has been accessed improperly, tell us, so we can investigate the audit
            trail.
          </p>
        </Section>

        <Section id="your-rights" title="Your rights">
          <p>
            Under the Kenyan Data Protection Act 2019 you may ask to access,
            correct or delete your personal data, to object to or restrict how it
            is used, and to receive a copy in a portable form. You may also
            complain to the Office of the Data Protection Commissioner.
          </p>
          <p>
            Because most data in Raut belongs to a customer company, we normally
            have to pass such requests to that company as the controller.
            Approaching them directly is usually quicker.
          </p>
        </Section>

        <Section id="contact" title="Contact">
          <p>
            Tari Africa Platforms Limited, Nairobi, Kenya.
            <br />
            Privacy enquiries:{" "}
            <a
              className="text-accent hover:underline"
              href="mailto:phinetechltd@gmail.com"
            >
              phinetechltd@gmail.com
            </a>
            {" — or use the "}
            <Link href="/contact-us" className="text-accent hover:underline">
              contact form
            </Link>
            {", which prefills what we need."}
          </p>
          <p className="text-content-muted text-sm">
            If we change how the platform handles personal data, we will update
            this page and the date at the top.
          </p>
        </Section>
      </article>
    </main>
  );
}
