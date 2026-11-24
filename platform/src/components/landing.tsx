import Image from "next/image";
import Link from "next/link";

import { cx } from "@/components/ui";
import { RautLockup, RautWordmark } from "@/components/raut-mark";
import { Reveal } from "@/components/landing-reveal";

/**
 * Public landing page.
 *
 * Every phone image is a real screenshot of the Flutter app running against a
 * seeded platform — captured by `integration_test/screenshots_test.dart`, not
 * mocked up. If the UI changes, re-run that drive and the page follows.
 *
 * Motion is progressive enhancement: the `Reveal` wrapper renders visible on
 * the server, so crawlers and no-JS visitors lose nothing, and the CSS honours
 * prefers-reduced-motion.
 */

// ── inline icon set (stroke, currentColor) ────────────────────────────────
const PATHS: Record<string, string> = {
  pipeline: "M3 5h18M6 12h12M10 19h4",
  quote: "M7 3h7l5 5v13H7zM14 3v5h5M9 13h6M9 17h4",
  wallet: "M3 7h15a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V6a2 2 0 0 1 2-2h11M16 12h2",
  shield: "M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4",
  box: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  truck: "M3 6h11v9H3zM14 9h4l3 3v3h-7M7 18a2 2 0 1 0 0.01 0M18 18a2 2 0 1 0 0.01 0",
  ledger: "M5 3h12a2 2 0 0 1 2 2v16l-4-2-4 2-4-2-2 1V5a2 2 0 0 1 2-2zM9 8h6M9 12h6",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  sms: "M4 5h16v10H9l-4 3v-3H4zM8 10h.01M12 10h.01M16 10h.01",
  chat: "M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4V6a2 2 0 0 1 0-2zM8 9h8M8 12h5",
  calendar: "M4 5h16v16H4zM4 9h16M8 3v4M16 3v4M9 14h2v2H9z",
  video: "M3 7h12v10H3zM15 10l6-3v10l-6-3z",
  offline: "M12 19h.01M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M2 8l20 8",
  route: "M6 19a2 2 0 1 0 0.01 0M18 5a2 2 0 1 0 0.01 0M8 19h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6",
  pin: "M12 21s7-5.2 7-11a7 7 0 1 0-14 0c0 5.8 7 11 7 11zM12 8a2 2 0 1 0 0.01 0",
  car: "M5 11l2-5h10l2 5M4 11h16v5H4zM7 16a1.5 1.5 0 1 0 0.01 0M17 16a1.5 1.5 0 1 0 0.01 0",
  users: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M22 20a6 6 0 0 0-5-5.9",
};

function Glyph({ name, className }: { name: keyof typeof PATHS | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

type Feature = { icon: string; title: string; body: string };
type Group = { kicker: string; title: string; items: Feature[] };

const GROUPS: Group[] = [
  {
    kicker: "Sell & get paid",
    title: "From first contact to a filed invoice",
    items: [
      { icon: "users", title: "CRM & pipeline", body: "Leads, a drag-free deal pipeline, contacts and a shared task board — the whole funnel, on web and in the field app." },
      { icon: "quote", title: "Quotations → orders → invoices", body: "Price a quote once; convert the accepted one straight to an order or an issued invoice, with the numbers carried across untouched." },
      { icon: "wallet", title: "Receivables & payments", body: "Credit limits, ageing and payment capture, with the balance in front of the rep before they write the next order." },
      { icon: "shield", title: "KRA eTIMS built in", body: "Invoices and credit notes filed with KRA, returning the control code and QR that make them valid tax documents." },
    ],
  },
  {
    kicker: "Know your numbers",
    title: "Stock, suppliers and the ledger, in step",
    items: [
      { icon: "box", title: "Multi-location inventory", body: "One stock pool across stores and vans, transfers in parts, valued movements and low-stock alerts." },
      { icon: "truck", title: "Procurement & suppliers", body: "Purchase orders, goods-received notes and supplier bills that post to payables and input VAT." },
      { icon: "ledger", title: "Finance & accounting", body: "Double-entry journals, a chart of accounts, month close, expenses and the receivables dashboard." },
      { icon: "chart", title: "Reports & analytics", body: "A report centre with 50+ reports plus the financial statements — searchable, exportable and printable." },
    ],
  },
  {
    kicker: "Reach everyone",
    title: "Talk to customers and to the field",
    items: [
      { icon: "mail", title: "Email & bulk campaigns", body: "One-off emails and campaigns to a customer segment, sent from your own mail server, with one-click unsubscribe." },
      { icon: "sms", title: "SMS communication", body: "Order and payment confirmations, balance reminders and promotions, from the same customer book." },
      { icon: "chat", title: "Office ↔ field messaging", body: "A thread with every rep and a broadcast to all of them — in the console and on the handset, offline-first." },
      { icon: "video", title: "Visit calendar & online meetings", body: "A week-view visit planner and scheduled video meetings in a one-click room, with an email invite to the customer." },
    ],
  },
  {
    kicker: "In the field",
    title: "Built for the mile the network forgets",
    items: [
      { icon: "offline", title: "Offline-first Android app", body: "Every order, payment and visit lands on the device first; the UI never waits on the network, and sync drains later." },
      { icon: "route", title: "Smart routing", body: "A sequenced daily route — nearest-neighbour with a 2-opt pass — that stays stable so a rep can trust the order." },
      { icon: "pin", title: "Geofenced visits", body: "Check-ins verified against the customer's fence by the server, with the distance shown plainly — not trusted from the phone." },
      { icon: "car", title: "GPS vehicle tracking", body: "We supply trackers and SIM cards; every vehicle shows on a live map beside your sales, stock and routes." },
    ],
  },
];

const SCREENS = [
  {
    src: "/screens/03-route.png",
    alt: "Today's Route in the Raut field app, showing five sequenced stops with balances and status",
    kicker: "The day, in order",
    title: "Every rep opens to a sequenced route",
    body: "Stops arrive in the order the optimiser set, distances estimated at 1.35× crow-flight so the ETA is honest. The app never re-sorts them — a route that reshuffles under a rep as they drive is worse than a suboptimal one they can trust.",
    points: ["Planned time, town and distance for each stop", "What the shop owes, with over-limit balances called out", "Progress and driving estimate for the whole day"],
  },
  {
    src: "/screens/07-visit.png",
    alt: "A visit in the Raut app: GPS verified 72m from the shop, credit limit warning, outstanding invoices",
    kicker: "At the counter",
    title: "Check in, sell and collect on one screen",
    body: "Check-in captures GPS and verifies it against the customer's geofence. The balance and credit limit are on screen before the rep writes an order, and overdue invoices are right there — so the collection conversation happens while they are standing in the shop.",
    points: ["GPS verification computed server-side, not trusted from the handset", "Explicit warning when a customer is over their credit limit", "Outstanding invoices with due dates, overdue ones in red"],
  },
  {
    src: "/screens/04-customers.png",
    alt: "The Raut customer book, searchable offline, showing balances and GPS pins",
    kicker: "The whole book, offline",
    title: "Every customer, with no signal",
    body: "The customer book lives on the device. Search by name, code, phone or town in a basement with no bars. New shops can be added in the field and come back with a real customer code once they sync.",
    points: ["Balances and segment visible in the list", "A filter for accounts actually worth visiting", "GPS pins captured by reps — the raw material for routing"],
  },
];

const STATS: Array<[string, string]> = [
  ["11", "modules, one login"],
  ["0 bars", "works fully offline"],
  ["KRA", "eTIMS tax invoices"],
  ["GPS", "server-verified visits"],
];

/**
 * A premium phone mockup: a dark device frame with a notch, a soft brand-tinted
 * glow behind it, and a crisp inset screenshot. Scales down on small screens.
 */
function Phone({
  src,
  alt,
  priority = false,
  float = false,
  tone = "light",
}: {
  src: string;
  alt: string;
  priority?: boolean;
  float?: boolean;
  tone?: "light" | "dark";
}) {
  return (
    <div className={cx("relative mx-auto w-[220px] max-w-full sm:w-[248px] md:w-[272px]", float && "lp-float")}>
      {/* glow */}
      <div
        aria-hidden
        className="absolute -inset-5 -z-10 rounded-[3rem] blur-2xl"
        style={{
          background:
            tone === "dark"
              ? "radial-gradient(60% 60% at 50% 40%, color-mix(in srgb, var(--brand-500) 55%, transparent), transparent 70%)"
              : "radial-gradient(60% 55% at 50% 45%, color-mix(in srgb, var(--brand-500) 26%, transparent), transparent 70%)",
          opacity: tone === "dark" ? 0.75 : 0.5,
        }}
      />
      {/* device */}
      <div
        className="relative rounded-[2.25rem] p-[9px] shadow-2xl ring-1 ring-black/10"
        style={{ background: "linear-gradient(150deg, #332e29 0%, #15110d 55%, #0c0a07 100%)" }}
      >
        {/* notch */}
        <div className="absolute left-1/2 top-[13px] z-10 h-[6px] w-14 -translate-x-1/2 rounded-full bg-black/70" aria-hidden />
        <div className="overflow-hidden rounded-[1.7rem] bg-black">
          <Image
            src={src}
            alt={alt}
            width={520}
            height={1167}
            priority={priority}
            quality={92}
            sizes="(max-width: 640px) 220px, 272px"
            className="h-auto w-full"
          />
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="bg-bg min-h-screen">
      {/* ── nav ─────────────────────────────────────────────────────── */}
      <header className="border-border bg-surface/90 sticky top-0 z-20 border-b backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <RautWordmark compact />
          <div className="flex items-center gap-5 text-sm">
            <a href="#features" className="text-content-secondary hidden hover:underline sm:inline">Features</a>
            <a href="#how" className="text-content-secondary hidden hover:underline sm:inline">The app</a>
            <Link href="/gps-trackers" className="text-content-secondary hidden hover:underline md:inline">GPS trackers</Link>
            <Link href="/blog" className="text-content-secondary hover:underline">Blog</Link>
            <Link href="/login" className="text-content-secondary hover:underline">Sign in</Link>
            <Link href="/signup" className="bg-accent hover:bg-accent-hover rounded-lg px-4 py-2 font-medium text-white transition-colors">Start free</Link>
          </div>
        </nav>
        <div className="afr-band" aria-hidden="true" />
      </header>

      {/* ── hero ────────────────────────────────────────────────────── */}
      <section className="afr-weave-dark bg-ink-950 relative overflow-hidden text-white">
        <div className="lp-aurora pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 sm:px-6 sm:py-20 lg:grid-cols-2 lg:py-28">
          <div className="lp-rise">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-medium text-white/80">
              <span className="lp-live-dot inline-block h-2 w-2 rounded-full" style={{ background: "var(--accent-green-400)" }} />
              One platform for the whole trade operation
            </span>
            <div className="mt-6"><RautLockup size={250} onDark /></div>
            <h1 className="font-display mt-7 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
              Run the business.<br />Reach every mile.
            </h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-white/75">
              Raut is the ERP and field-sales platform for African distributors — CRM, sales, stock, finance, messaging and scheduling in one console, with an offline-first app in the hands of the reps who work where the network does not.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="bg-accent hover:bg-accent-hover rounded-lg px-5 py-3 text-sm font-medium text-white transition-colors">Start free</Link>
              <Link href="/login" className="rounded-lg border border-white/25 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-white/10">Sign in to the console</Link>
            </div>
            <p className="mt-7 text-xs text-white/60">Tari Africa Platforms Limited · Nairobi</p>
          </div>

          <div className="lg:justify-self-end">
            <Phone src="/screens/03-route.png" alt="Today's Route in the Raut field app" priority float tone="dark" />
          </div>
        </div>

        {/* stat band */}
        <div className="relative border-t border-white/10">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-6 sm:grid-cols-4">
            {STATS.map(([big, small], i) => (
              <Reveal key={small} delayMs={i * 80} className="px-2 py-6 text-center">
                <p className="font-display text-2xl font-semibold text-white sm:text-3xl">{big}</p>
                <p className="mt-1 text-xs text-white/60">{small}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── premise ─────────────────────────────────────────────────── */}
      <section className="border-border border-b">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 sm:grid-cols-3">
          {[
            ["Works with no signal", "Every write lands in the device's own store and an outbox in the same action. The UI never waits on the network."],
            ["Field work you can verify", "Check-ins are tested against the customer's geofence by the server, and the result is written by the check-in path — never by the client."],
            ["One tenant cannot see another", "Every row carries its company, and that scope comes from the signed-in session rather than anything the client sends."],
          ].map(([title, body], i) => (
            <Reveal key={title} delayMs={i * 90}>
              <h3 className="font-semibold tracking-tight">{title}</h3>
              <p className="text-content-secondary mt-2 text-[15px] leading-relaxed">{body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── feature grid ────────────────────────────────────────────── */}
      <section id="features" className="scroll-mt-16">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Reveal>
            <p className="text-accent text-xs font-semibold uppercase tracking-[0.15em]">Everything in one place</p>
            <h2 className="font-display mt-2 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">One system for selling, stock, money and the field</h2>
            <p className="text-content-secondary mt-3 max-w-2xl text-[15px] leading-relaxed">
              Licensed by module, enforced at runtime — buy what you use. Here is the whole of it.
            </p>
          </Reveal>

          <div className="mt-12 space-y-14">
            {GROUPS.map((group) => (
              <div key={group.kicker}>
                <Reveal className="mb-5">
                  <p className="text-accent text-xs font-semibold uppercase tracking-[0.15em]">{group.kicker}</p>
                  <h3 className="mt-1.5 text-lg font-semibold tracking-tight sm:text-xl">{group.title}</h3>
                </Reveal>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {group.items.map((f, i) => (
                    <Reveal key={f.title} delayMs={i * 70}>
                      <div className="lp-card afr-card border-border bg-surface h-full rounded-xl border p-5">
                        <span className="bg-accent-subtle text-accent grid h-10 w-10 place-items-center rounded-lg">
                          <Glyph name={f.icon} />
                        </span>
                        <h4 className="mt-4 font-semibold tracking-tight">{f.title}</h4>
                        <p className="text-content-secondary mt-1.5 text-sm leading-relaxed">{f.body}</p>
                      </div>
                    </Reveal>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── app screenshots ─────────────────────────────────────────── */}
      <section id="how" className="border-border scroll-mt-16 border-t bg-surface-sunken">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Reveal>
            <p className="text-accent text-xs font-semibold uppercase tracking-[0.15em]">The field app</p>
            <h2 className="font-display mt-2 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">What a rep actually sees, screen by screen</h2>
            <p className="text-content-secondary mt-3 max-w-2xl text-[15px] leading-relaxed">Every image below is a screenshot of the app running against a live platform — not a mockup.</p>
          </Reveal>

          <div className="mt-14 space-y-20">
            {SCREENS.map((s, i) => (
              <Reveal key={s.src}>
                <div className={`flex flex-col items-center gap-10 lg:flex-row lg:gap-16 ${i % 2 === 1 ? "lg:flex-row-reverse" : ""}`}>
                  <Phone src={s.src} alt={s.alt} />
                  <div className="max-w-xl">
                    <p className="text-accent text-xs font-semibold uppercase tracking-[0.15em]">{s.kicker}</p>
                    <h3 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{s.title}</h3>
                    <p className="text-content-secondary mt-3 text-[15px] leading-relaxed">{s.body}</p>
                    <ul className="mt-5 space-y-2.5">
                      {s.points.map((p) => (
                        <li key={p} className="flex gap-3 text-[15px]">
                          <span aria-hidden className="bg-accent mt-2 h-1.5 w-1.5 shrink-0 rounded-full" />
                          <span className="text-content-secondary">{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── tracking ──────────────────────────────────────────────── */}
      <section className="afr-weave-dark bg-ink-950 text-white">
        <div className="afr-band" aria-hidden="true" />
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-16 lg:flex-row lg:items-center lg:justify-between">
          <Reveal className="max-w-2xl">
            <p className="text-brand-300 text-xs font-semibold uppercase tracking-[0.15em]">Kila gari, kila safari · Every vehicle, every trip</p>
            <h2 className="font-display mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">GPS trackers and SIM cards, built into the system</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-white/80">We supply tracking devices and SIM cards, and every vehicle appears on a live map alongside your sales, stock and routes.</p>
          </Reveal>
          <Reveal className="flex shrink-0 flex-wrap gap-3 text-sm font-medium">
            <Link href="/gps-trackers" className="bg-accent hover:bg-accent-hover rounded-lg px-5 py-3 text-white transition-colors">See GPS trackers</Link>
            <Link href="/blog" className="rounded-lg border border-white/30 px-5 py-3 text-white transition-colors hover:bg-white/10">Read the logistics blog</Link>
          </Reveal>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────── */}
      <section className="border-border border-t">
        <div className="mx-auto max-w-6xl px-6 py-16 text-center">
          <Reveal>
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Ready to run it all from one place?</h2>
            <p className="text-content-secondary mx-auto mt-3 max-w-xl text-[15px] leading-relaxed">Create your workspace free, or talk to us about rolling Raut out to your field team.</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link href="/signup" className="bg-accent hover:bg-accent-hover rounded-lg px-6 py-3 text-sm font-medium text-white transition-colors">Start free</Link>
              <Link href="/login" className="border-border rounded-lg border px-6 py-3 text-sm font-medium transition-colors hover:bg-surface-hover">Sign in</Link>
              <Link href="/contact-us" className="border-border rounded-lg border px-6 py-3 text-sm font-medium transition-colors hover:bg-surface-hover">Contact us</Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── footer ──────────────────────────────────────────────────── */}
      <footer className="border-t border-white/10 bg-ink-950 text-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Raut</p>
            <p className="mt-1 text-sm text-white/55">Tari Africa Platforms Limited · Nairobi, Kenya</p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/login" className="text-white/75 hover:text-white">Sign in</Link>
            <Link href="/blog" className="text-white/75 hover:text-white">Blog</Link>
            <Link href="/gps-trackers" className="text-white/75 hover:text-white">GPS trackers</Link>
            <Link href="/terms" className="text-white/75 hover:text-white">Terms</Link>
            <Link href="/policy" className="text-white/75 hover:text-white">Privacy &amp; Cookies</Link>
            <Link href="/contact-us" className="text-white/75 hover:text-white">Contact us</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
