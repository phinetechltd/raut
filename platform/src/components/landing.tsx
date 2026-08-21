import Image from "next/image";
import Link from "next/link";

import { RautLockup, RautWordmark } from "@/components/raut-mark";

/**
 * Public landing page.
 *
 * Every phone image is a real screenshot of the Flutter app running against a
 * seeded platform — captured by `integration_test/screenshots_test.dart`, not
 * mocked up. If the UI changes, re-run that drive and the page follows.
 */

type Screen = {
  src: string;
  alt: string;
  kicker: string;
  title: string;
  body: string;
  points: string[];
};

const SCREENS: Screen[] = [
  {
    src: "/screens/03-route.png",
    alt: "Today's Route in the Raut field app, showing five sequenced stops with balances and status",
    kicker: "The day, in order",
    title: "Every rep opens to a sequenced route",
    body:
      "Stops arrive in the order the optimiser set — nearest-neighbour with a 2-opt pass, distances estimated at 1.35× crow-flight so the ETA is honest. The app never re-sorts them; a route that reshuffles under a rep as they drive is worse than a suboptimal one they can trust.",
    points: [
      "Planned time, town and distance for each stop",
      "What the shop owes, with over-limit balances called out",
      "Progress and driving estimate for the whole day",
    ],
  },
  {
    src: "/screens/07-visit.png",
    alt: "A visit in the Raut app: GPS verified 72m from the shop, credit limit warning, outstanding invoices",
    kicker: "At the counter",
    title: "Check in, sell and collect on one screen",
    body:
      "Check-in captures GPS and verifies it against the customer's geofence, showing the distance plainly. The balance and credit limit are on screen before the rep writes an order, and overdue invoices are right there — so the collection conversation happens while they are standing in the shop.",
    points: [
      "GPS verification computed server-side, not trusted from the handset",
      "Explicit warning when a customer is over their credit limit",
      "Outstanding invoices with due dates, overdue ones in red",
    ],
  },
  {
    src: "/screens/04-customers.png",
    alt: "The Raut customer book, searchable offline, showing balances and GPS pins",
    kicker: "The whole book, offline",
    title: "Every customer, with no signal",
    body:
      "The customer book lives on the device. Search by name, code, phone or town in a basement with no bars. New shops can be added in the field and come back with a real customer code once they sync.",
    points: [
      "Balances and segment visible in the list",
      "A filter for accounts actually worth visiting",
      "GPS pins captured by reps — the raw material for routing",
    ],
  },
  {
    src: "/screens/05-today.png",
    alt: "The Today screen showing visits done, GPS verified, orders and cash collected",
    kicker: "Their numbers, not yours",
    title: "A rep can see their own day",
    body:
      "Visits done, GPS-verified check-ins, orders written and cash collected. The sync panel says plainly whether the office has everything yet — which is the question reps actually care about at the end of a shift.",
    points: [
      "Answers “have I been credited for today’s work”",
      "Sync state in words, not a spinner",
    ],
  },
  {
    src: "/screens/06-more.png",
    alt: "The More screen showing the sync queue, expense claims and licensed modules",
    kicker: "Nothing hidden",
    title: "The queue is visible, so nothing feels lost",
    body:
      "The sync queue shows exactly what is still waiting to reach the office. Expense claims — fuel, airtime, travel — are captured in the field and flow to Finance. Location tracking is opt-in and labelled when it is off.",
    points: [
      "Transparency is what stops reps re-entering work they think vanished",
      "Licensed modules listed, so a missing feature has an explanation",
    ],
  },
];

const MODULES = [
  "CRM & Customer Management",
  "Sales & POS",
  "Inventory Management",
  "Procurement & Suppliers",
  "Finance & Receivables",
  "Field Sales Management",
  "Smart Routing",
  "Geofencing & Location Intel",
  "SMS Communication",
  "Advanced Reporting",
];

function Phone({ src, alt, priority = false }: { src: string; alt: string; priority?: boolean }) {
  return (
    <div className="border-border bg-surface mx-auto w-[260px] shrink-0 rounded-[28px] border p-2 shadow-xl">
      <Image
        src={src}
        alt={alt}
        width={520}
        height={1167}
        priority={priority}
        className="h-auto w-full rounded-[22px]"
      />
    </div>
  );
}

export function Landing() {
  return (
    <div className="bg-bg min-h-screen">
      {/* ── nav ─────────────────────────────────────────────────────── */}
      <header className="border-border bg-surface sticky top-0 z-10 border-b">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <RautWordmark compact />
          <div className="flex items-center gap-5 text-sm">
            <a href="#how" className="text-content-secondary hidden hover:underline sm:inline">
              How it works
            </a>
            <a href="#modules" className="text-content-secondary hidden hover:underline sm:inline">
              Modules
            </a>
            <Link
              href="/login"
              className="bg-accent hover:bg-accent-hover rounded-lg px-4 py-2 font-medium text-white"
            >
              Sign in
            </Link>
          </div>
        </nav>
      </header>

      {/* ── hero ────────────────────────────────────────────────────── */}
      <section className="bg-ink-950 text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 lg:grid-cols-2 lg:py-24">
          <div>
            <RautLockup size={260} onDark />
            <h1 className="mt-8 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              One platform. Every mile.
            </h1>
            <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-white/75">
              Raut runs the whole trade operation — customers, stock, invoices and
              collections — and puts an offline-first Android app in the hands of
              the reps who work where the network does not.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="bg-accent hover:bg-accent-hover rounded-lg px-5 py-3 text-sm font-medium text-white"
              >
                Sign in to the console
              </Link>
              <a
                href="#how"
                className="rounded-lg border border-white/25 px-5 py-3 text-sm font-medium text-white hover:bg-white/10"
              >
                See the app
              </a>
            </div>
            <p className="mt-6 text-xs text-white/45">
              Tari Africa Platforms Limited · Nairobi
            </p>
          </div>

          <div className="lg:justify-self-end">
            <Phone
              src="/screens/03-route.png"
              alt="Today's Route in the Raut field app"
              priority
            />
          </div>
        </div>
      </section>

      {/* ── the premise ─────────────────────────────────────────────── */}
      <section className="border-border border-b">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 sm:grid-cols-3">
          {[
            [
              "Works with no signal",
              "Every write lands in the device's own store and an outbox in the same action. The UI never waits on the network.",
            ],
            [
              "Field work you can verify",
              "Check-ins are tested against the customer's geofence by the server, and the result is written by the check-in path — never by the client.",
            ],
            [
              "One tenant cannot see another",
              "Every row carries its company, and that scope comes from the signed-in session rather than anything the client sends.",
            ],
          ].map(([title, body]) => (
            <div key={title}>
              <h3 className="font-semibold tracking-tight">{title}</h3>
              <p className="text-content-secondary mt-2 text-[15px] leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── screens ─────────────────────────────────────────────────── */}
      <section id="how" className="scroll-mt-16">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <p className="text-accent text-xs font-semibold uppercase tracking-[0.15em]">
            The field app
          </p>
          <h2 className="mt-2 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
            What a rep actually sees, screen by screen
          </h2>
          <p className="text-content-secondary mt-3 max-w-2xl text-[15px] leading-relaxed">
            Every image below is a screenshot of the app running against a live
            platform — not a mockup.
          </p>

          <div className="mt-14 space-y-20">
            {SCREENS.map((s, i) => (
              <div
                key={s.src}
                className={`flex flex-col items-center gap-10 lg:flex-row lg:gap-16 ${
                  i % 2 === 1 ? "lg:flex-row-reverse" : ""
                }`}
              >
                <Phone src={s.src} alt={s.alt} />
                <div className="max-w-xl">
                  <p className="text-accent text-xs font-semibold uppercase tracking-[0.15em]">
                    {s.kicker}
                  </p>
                  <h3 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">
                    {s.title}
                  </h3>
                  <p className="text-content-secondary mt-3 text-[15px] leading-relaxed">
                    {s.body}
                  </p>
                  <ul className="mt-5 space-y-2.5">
                    {s.points.map((p) => (
                      <li key={p} className="flex gap-3 text-[15px]">
                        <span
                          aria-hidden
                          className="bg-accent mt-2 h-1.5 w-1.5 shrink-0 rounded-full"
                        />
                        <span className="text-content-secondary">{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── modules ─────────────────────────────────────────────────── */}
      <section id="modules" className="border-border scroll-mt-16 border-t">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <p className="text-accent text-xs font-semibold uppercase tracking-[0.15em]">
            Licensed per company
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            A core platform, plus the ten modules you need
          </h2>
          <p className="text-content-secondary mt-3 max-w-2xl text-[15px] leading-relaxed">
            The core — companies, branches, users, roles and audit — is always
            included. Each module is licensed separately and enforced at runtime,
            so a distributor can buy selling without buying the ledger.
          </p>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((m, i) => (
              <li
                key={m}
                className="border-border bg-surface flex items-center gap-3 rounded-lg border px-4 py-3 text-sm"
              >
                <span className="text-content-muted w-6 shrink-0 tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {m}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── footer ──────────────────────────────────────────────────── */}
      <footer className="bg-ink-950 text-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Raut</p>
            <p className="mt-1 text-sm text-white/55">
              Tari Africa Platforms Limited · Nairobi, Kenya
            </p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/login" className="text-white/75 hover:text-white">
              Sign in
            </Link>
            <Link href="/policy" className="text-white/75 hover:text-white">
              Privacy &amp; Cookies
            </Link>
            <Link href="/contact-us" className="text-white/75 hover:text-white">
              Contact us
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
