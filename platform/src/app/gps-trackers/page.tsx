import type { Metadata } from "next";
import Link from "next/link";

import { PublicChrome } from "@/components/public-chrome";
import { absoluteUrl, breadcrumbSchema, faqSchema, jsonLd, quoteMailto, serviceSchema, whatsappLink } from "@/lib/seo";

const TITLE = "GPS Trackers and Tracker SIM Cards in Kenya | Raut";
const DESCRIPTION =
  "GPS tracking devices, tracker SIM cards and live fleet tracking for trucks, vans and bikes in Kenya, in the system that also runs your sales and stock.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  keywords: ["GPS tracker Kenya", "vehicle tracking Kenya", "fleet tracking Kenya", "tracker SIM card", "M2M SIM Kenya"],
  alternates: { canonical: absoluteUrl("/gps-trackers") },
  openGraph: {
    type: "website",
    url: absoluteUrl("/gps-trackers"),
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Raut",
    locale: "en_KE",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const OFFER = [
  {
    title: "Tracking devices",
    body: "GPS units for trucks, vans, pick-ups and motorbikes. Tell us what you run and we will recommend what fits, and arrange fitting.",
  },
  {
    title: "Tracker SIM cards",
    body: "Lines for tracking, so a van does not vanish from the map because a bundle ran out on someone's personal phone number.",
  },
  {
    title: "Live fleet tracking",
    body: "See every vehicle's status, where it is now and how long since it last reported, on Google Maps or OpenStreetMap.",
  },
];

const FEATURES = [
  ["Moving, idling, parked or offline", "Each vehicle's status at a glance. A van that goes quiet shows as offline, not at its last position as if nothing had changed."],
  ["A record of every day", "Each vehicle's trail, distance, time moving, top speed and stops, for any date."],
  ["Vehicle utilisation reports", "Distance, hours moving and days out per vehicle, ready to export to a spreadsheet or print."],
  ["Works with what you own", "Devices already on a Traccar server, or any platform that can send a web request, can report in through our API."],
  ["Phones as a backup", "With no tracker fitted, or one that has gone quiet, the driver's phone in the Raut app can stand in, and the screen says which source you are seeing."],
  ["Permissions that fit the job", "Managers see the fleet, a rep sees only the van they drive, and other staff see none of it."],
];

const FAQ = [
  {
    q: "What do I need to start tracking?",
    a: "A tracking device for each vehicle, a SIM card for each device, and a Raut account. We can supply the devices and SIM cards, and advise on fitting.",
  },
  {
    q: "Can I use trackers I already have?",
    a: "Often, yes. Any platform that can send positions through a web request can report through Raut's API, and devices on a Traccar server can forward positions directly.",
  },
  {
    q: "Which vehicles can be tracked?",
    a: "Trucks, vans, pick-ups, cars and motorbikes are all set up as vehicles in Raut. Tell us your fleet and we will recommend a suitable device.",
  },
  {
    q: "Does this replace a KRA e-seal for transit cargo?",
    a: "No. Goods under customs control need a seal from a KRA-approved vendor. A fleet tracker is a separate tool for your own business.",
  },
  {
    q: "How much does it cost?",
    a: "It depends on your vehicles and how many you run. Send us your fleet details and we will send a quote.",
  },
];

const READING = [
  ["/blog/gps-tracking-kenya-buyers-guide", "How to buy GPS tracking in Kenya"],
  ["/blog/m2m-sim-cards-gps-trackers-kenya", "M2M SIM cards for GPS trackers"],
  ["/blog/cargo-theft-northern-corridor-2026", "Cargo theft on the Northern Corridor"],
  ["/blog/diesel-price-fleet-fuel-costs-kenya", "Cutting fleet fuel costs"],
];

export default function GpsTrackersPage() {
  const whatsapp = whatsappLink();
  const schema = [
    serviceSchema(DESCRIPTION),
    breadcrumbSchema([
      { name: "Home", path: "/" },
      { name: "GPS trackers and SIM cards", path: "/gps-trackers" },
    ]),
    faqSchema(FAQ),
  ];

  return (
    <PublicChrome>
      {schema.map((item, index) => (
        <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(item) }} />
      ))}

      <section className="afr-weave-dark bg-ink-950 text-white">
        <div className="mx-auto max-w-6xl px-6 py-16 lg:py-20">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand-300">Kila gari, kila safari · Every vehicle, every trip</p>
          <h1 className="font-display mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-4xl">
            GPS trackers, tracker SIM cards and live fleet tracking in Kenya
          </h1>
          <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-white/80">{DESCRIPTION}</p>
          <div className="mt-8 flex flex-wrap gap-3 text-sm font-medium">
            <a href={quoteMailto()} className="rounded-lg bg-accent px-5 py-3 text-white hover:bg-accent-hover">
              Request a quote
            </a>
            {whatsapp ? (
              <a href={whatsapp} rel="noopener" className="rounded-lg border border-white/30 px-5 py-3 text-white hover:bg-white/10">
                WhatsApp us
              </a>
            ) : null}
            <Link href="/blog/gps-tracking-kenya-buyers-guide" className="rounded-lg border border-white/30 px-5 py-3 text-white hover:bg-white/10">
              Read the buyer&apos;s guide
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="font-display text-2xl font-semibold sm:text-3xl">One supplier for the device, the SIM and the system</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          {OFFER.map((item) => (
            <div key={item.title} className="afr-card rounded-xl border border-border bg-surface p-5">
              <h3 className="font-display text-lg font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-content-secondary">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <h2 className="font-display text-2xl font-semibold sm:text-3xl">What you can see in Raut</h2>
          <dl className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([term, detail]) => (
              <div key={term}>
                <dt className="font-semibold">{term}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-content-secondary">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-14">
        <h2 className="font-display text-2xl font-semibold sm:text-3xl">Frequently asked questions</h2>
        <div className="mt-6 space-y-3">
          {FAQ.map((item) => (
            <details key={item.q} className="rounded-lg border border-border bg-surface p-4" open>
              <summary className="cursor-pointer font-semibold">{item.q}</summary>
              <p className="mt-2 leading-relaxed text-content-secondary">{item.a}</p>
            </details>
          ))}
        </div>

        <h2 className="font-display mt-12 text-2xl font-semibold">Before you buy, read</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {READING.map(([href, label]) => (
            <li key={href} className="afr-card rounded-lg border border-border bg-surface p-4">
              <Link href={href} className="text-sm font-semibold hover:text-accent">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </PublicChrome>
  );
}
