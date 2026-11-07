/**
 * The Raut blog.
 *
 * Kept in the repository rather than a database: articles are reviewed like code,
 * ship with the build, and render as static HTML, which is what search engines
 * read fastest. `posts.test.ts` enforces the SEO rules on every article.
 *
 * Inline links use [text](url). Every factual claim about the market or the law
 * carries a source below it. Nothing here states a price, a device model or a
 * licence that the business has not confirmed.
 */

export type Block =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "note"; text: string }
  | { type: "table"; caption: string; headers: string[]; rows: string[][] };

export interface Section {
  heading: string;
  blocks: Block[];
}

export interface Source {
  label: string;
  url: string;
  /** When the source was published, as it stated. */
  date?: string;
}

export const CLUSTERS = {
  buying: { label: "Buying a tracker", description: "Choosing GPS devices, SIM cards and a licensed provider." },
  security: { label: "Cargo security", description: "Theft, hijacking and customs tracking on East African corridors." },
  costs: { label: "Fleet costs", description: "Fuel and running costs on Kenyan roads." },
  compliance: { label: "Law and compliance", description: "KRA, the Communications Authority and data protection." },
  trends: { label: "Industry trends", description: "What is changing in East African logistics." },
} as const;

export type Cluster = keyof typeof CLUSTERS;

export interface BlogPost {
  slug: string;
  /** The search result title: 60 characters or fewer. */
  title: string;
  /** The on-page headline, which can run longer. */
  headline: string;
  /** The search result snippet: 120 to 160 characters. */
  description: string;
  cluster: Cluster;
  primaryKeyword: string;
  keywords: string[];
  publishedAt: string;
  updatedAt: string;
  intro: string;
  /** A direct answer near the top, for featured snippets and AI overviews. */
  keyTakeaways: string[];
  sections: Section[];
  faq: Array<{ q: string; a: string }>;
  sources: Source[];
  related: string[];
}

const PUBLISHED = "2026-11-06";

export const POSTS: BlogPost[] = [
  {
    slug: "logistics-trends-kenya-east-africa-2026",
    title: "Logistics Trends in Kenya and East Africa for 2026",
    headline: "Seven logistics trends reshaping Kenya and East Africa in 2026",
    description:
      "Record port volumes, user-owned e-seals, new cargo rules, costly diesel and rising highway theft: what is changing for East African fleets in 2026.",
    cluster: "trends",
    primaryKeyword: "logistics trends Kenya 2026",
    keywords: ["logistics trends East Africa", "Northern Corridor 2026", "Kenya freight transport", "fleet management Kenya"],
    publishedAt: PUBLISHED,
    updatedAt: PUBLISHED,
    intro:
      "East African logistics is carrying more cargo, under more digital scrutiny, at a higher fuel cost than a year ago. For anyone running trucks, vans or delivery bikes, these are the changes that matter most, and what each one means for how a fleet is run.",
    keyTakeaways: [
      "The Port of Mombasa handled a record 45.45 million tonnes in 2025, and total throughput kept growing in the first half of 2026.",
      "KRA has moved cargo tracking to user-owned e-seals from 15 approved vendors, with a transition date of 26 October 2026.",
      "Nairobi diesel was capped at KSh 227.76 a litre for the cycle to 14 November 2026, which makes every wasted kilometre more expensive.",
    ],
    sections: [
      {
        heading: "1. Mombasa is busier, though the mix is shifting",
        blocks: [
          {
            type: "p",
            text: "Kenya's main port set records in 2025, handling 45.45 million tonnes of cargo and about 2.11 million containers (TEUs). The first half of 2026 tells a more mixed story: the Northern Corridor Transit and Transport Observatory reports throughput up 5% to 22.27 million tonnes, while container volume fell 3.6% to 976,792 TEUs against the same period in 2025.",
          },
          {
            type: "p",
            text: "For transporters the lesson is that bulk and transit demand is holding up even when boxes soften, so planning capacity on one headline number is risky. A fleet that can see its own trips per route, rather than guessing, adjusts faster.",
          },
        ],
      },
      {
        heading: "2. Cargo tracking has moved to the private market",
        blocks: [
          {
            type: "p",
            text: "KRA is phasing out its own electronic seals in favour of a multi-vendor, user-owned model under the Regional Electronic Cargo Tracking System. It has approved 15 vendors, and importers, exporters, clearing agents, transporters and bonded warehouses can choose among them. We explain what to do about it in our guide to [KRA's user-owned e-seals](/blog/kra-rects-user-owned-e-seals-transporters).",
          },
        ],
      },
      {
        heading: "3. Documents now move before the container does",
        blocks: [
          {
            type: "p",
            text: "KRA's Advance Cargo Declaration requires a reference for containerised cargo before it is loaded for Kenya. The platform opened on 3 August 2026 and carrier validation was due from 1 September. After trader protests, President Ruto ordered an exemption for cargo consolidators in early September, so check the current position with your clearing agent before relying on it.",
          },
        ],
      },
      {
        heading: "4. Rail and road capacity are being built on the same corridor",
        blocks: [
          {
            type: "p",
            text: "Ground was broken on the Naivasha to Kisumu and Malaba standard gauge extension in March 2026, while the Rironi to Mau Summit highway is being dualled. Published completion dates for both have moved, so treat them as direction rather than a timetable. When they do open, routes and handover points will change, and fleets with their own trip history will see the effect first.",
          },
        ],
      },
      {
        heading: "5. Diesel has become the number to manage",
        blocks: [
          {
            type: "p",
            text: "Diesel reached a record of over KSh 242 a litre in Nairobi in May 2026. After a cut in August it rose again in October to KSh 227.76. Our [fleet fuel guide](/blog/diesel-price-fleet-fuel-costs-kenya) covers what operators can actually control.",
          },
        ],
      },
      {
        heading: "6. Highway security is back on the agenda",
        blocks: [
          {
            type: "p",
            text: "Security firms and police both flagged cargo theft and attacks on drivers on the Malaba to Mombasa route during 2026. Read our [Northern Corridor cargo security analysis](/blog/cargo-theft-northern-corridor-2026) for what the incidents suggest about layered protection.",
          },
        ],
      },
      {
        heading: "7. Regulators are looking at tracking itself",
        blocks: [
          {
            type: "ul",
            items: [
              "The Communications Authority has warned businesses to use only licensed vehicle tracking providers. See our [GPS tracker buyer's guide](/blog/gps-tracking-kenya-buyers-guide).",
              "The Data Protection Commissioner published draft transport guidance in April 2026 that treats real-time location as a significant privacy concern. See [tracking drivers lawfully](/blog/gps-tracking-drivers-data-protection-kenya).",
              "Electric delivery is growing too, with Roam launching a connected-vehicle platform for electric fleets in March 2026, so tracking is no longer only a truck question.",
            ],
          },
          {
            type: "p",
            text: "Together these point the same way: know where your vehicles are, keep the record, and buy from people who can show their paperwork. That is the thinking behind [Raut's GPS tracking and tracker SIM cards](/gps-trackers).",
          },
        ],
      },
    ],
    faq: [
      {
        q: "What is the biggest logistics trend in Kenya in 2026?",
        a: "Digital control of cargo is the clearest shift, with KRA's user-owned e-seals and the Advance Cargo Declaration both taking effect during 2026, alongside continued growth in tonnage at Mombasa.",
      },
      {
        q: "Is the Port of Mombasa still growing?",
        a: "Total throughput grew 5% in the first half of 2026 to 22.27 million tonnes, while container volume fell 3.6%, according to the Northern Corridor observatory.",
      },
      {
        q: "When will the Naivasha to Malaba railway be finished?",
        a: "Construction began in 2026, and reported completion dates have varied. Check Kenya Railways for the current schedule rather than relying on a single published date.",
      },
    ],
    sources: [
      { label: "Northern Corridor Transport Observatory, biannual report January to June 2026", url: "https://top.ttcanc.org/uploads/attachments/cmspuxn6h0de8hfnu9smo4ulg-biannual-report-jan-to-jun-2026.pdf" },
      { label: "Kenya News Agency, Mombasa port expansion and digitisation", url: "https://www.kenyanews.go.ke/mombasa-port-ramps-up-expansion-digitisation-as-cargo-volumes-rise/" },
      { label: "Kenyans.co.ke, KRA to replace its cargo tracking seals", url: "https://www.kenyans.co.ke/news/126981-kra-replace-its-cargo-tracking-seals-new-vendor-system-october-26", date: "11 September 2026" },
      { label: "The Star, KRA to launch new cargo declaration system on August 3", url: "https://www.the-star.co.ke/news/2026-07-14-kra-to-launch-new-cargo-declaration-system-on-august-3", date: "14 July 2026" },
      { label: "AllAfrica, Ruto orders ACD exemption for cargo consolidators", url: "https://allafrica.com/stories/202609030035.html", date: "3 September 2026" },
      { label: "The Star, Ruto breaks ground for Naivasha-Malaba SGR", url: "https://www.the-star.co.ke/news/2026-03-19-ruto-breaks-ground-for-naivasha-malaba-sgr", date: "19 March 2026" },
      { label: "Kenyans.co.ke, Rironi-Naivasha highway dualling", url: "https://www.kenyans.co.ke/news/126936-rironi-naivasha-highway-be-fully-dualled-october-30-chirchir-says" },
      { label: "Tech-ish, EPRA October 2026 fuel review", url: "https://tech-ish.com/2026/10/14/petrol-rises-to-kes-226-96-in-nairobi-and-kerosene-jumps-kes-28-49/", date: "14 October 2026" },
      { label: "The Standard, diesel hits record Sh242", url: "https://www.standardmedia.co.ke/business/amp/national/article/2001547862/fuel-price-shocker-diesel-hits-record-sh242-as-pump-prices-jump-in-latest-epra-review" },
      { label: "AllAfrica, Roam launches connected vehicle platform", url: "https://allafrica.com/stories/202603100664.html", date: "10 March 2026" },
    ],
    related: ["gps-tracking-kenya-buyers-guide", "kra-rects-user-owned-e-seals-transporters", "diesel-price-fleet-fuel-costs-kenya"],
  },
  {
    slug: "gps-tracking-kenya-buyers-guide",
    title: "GPS Tracking for Trucks in Kenya: 2026 Buyer's Guide",
    headline: "How to buy GPS tracking for trucks and vans in Kenya",
    description:
      "How to choose a GPS tracker in Kenya in 2026: check the provider's CA licence, type approval and SIM, ask the right questions, and avoid common mistakes.",
    cluster: "buying",
    primaryKeyword: "GPS tracking Kenya",
    keywords: ["vehicle tracking Kenya", "fleet tracking Kenya", "GPS tracker for trucks", "car tracking companies in Kenya", "CA licensed tracking company"],
    publishedAt: PUBLISHED,
    updatedAt: PUBLISHED,
    intro:
      "A tracker is cheap compared with what it protects, so the real risk is not the price of the device. It is buying from a provider who is unlicensed, a device that was never approved, or a system that loses your history the day you change supplier. Here is how to check all three.",
    keyTakeaways: [
      "Ask for the provider's Communications Authority licence and Annual Compliance Certificate, and verify them yourself.",
      "A tracker with a SIM is telecoms equipment, so it should be type-approved and its SIM registered.",
      "Own your data: confirm you can get your trip history out, and that the system can accept devices from other suppliers.",
    ],
    sections: [
      {
        heading: "Start with the licence, not the device",
        blocks: [
          {
            type: "p",
            text: "In July 2025 the Communications Authority of Kenya warned businesses against unlicensed vehicle tracking and fleet management providers. It told organisations such as banks and motor dealers to use licensed providers and to check each one's Annual Compliance Certificate before engaging them. Tracking that is not accounted for, it said, will be treated as owned or run in-house, and running tracking in-house needs a direct licence.",
          },
          {
            type: "p",
            text: "The Authority cites sections of the Kenya Information and Communications Act and warns of prosecution, fines or imprisonment. Before you sign anything, look the provider up on the CA's licence register or ask the Authority directly.",
          },
          {
            type: "note",
            text: "Financing a vehicle? Your lender may have its own rules about which tracking companies it accepts, so ask before you buy.",
          },
        ],
      },
      {
        heading: "Check the device and its SIM",
        blocks: [
          {
            type: "p",
            text: "Telecoms equipment connected to a public network must be type-approved by the Authority before it is sold or used, and the CA publishes the list of approved equipment. A tracker is a small cellular device, so the same question applies: ask your seller to show the type approval. The SIM inside it matters just as much, which is why we wrote a separate [guide to M2M SIM cards for trackers](/blog/m2m-sim-cards-gps-trackers-kenya).",
          },
        ],
      },
      {
        heading: "Questions to ask any tracking company",
        blocks: [
          {
            type: "ol",
            items: [
              "Can you show your CA licence and current Annual Compliance Certificate?",
              "Is this device model type-approved in Kenya?",
              "Whose name is the SIM registered in, and what happens when it runs out of data?",
              "How often does it report when moving, and when parked?",
              "Does it store positions and resend them after a dead zone, or are they lost?",
              "Who owns the trip history, and how do I export it if I leave?",
              "What is the warranty, and how long does a replacement take outside Nairobi?",
              "Does the system flag a device that has gone silent, in case it was disconnected?",
            ],
          },
        ],
      },
      {
        heading: "What a fleet actually needs from the software",
        blocks: [
          {
            type: "table",
            caption: "What to look for in fleet tracking software",
            headers: ["Need", "Why it matters", "How to test it"],
            rows: [
              ["Live map with status", "Moving, idling, parked and offline need different responses", "Ask to see a van that has gone offline"],
              ["Daily trail", "Settles disputes about where a vehicle was", "Open any vehicle's trip from last week"],
              ["Stops and time moving", "Shows long unplanned stops", "Compare one day with the driver's log"],
              ["Offline buffering", "Upcountry roads have coverage gaps", "Check the trail across a known dead zone"],
              ["Open API", "You are not locked to one device brand", "Ask for the integration documentation"],
            ],
          },
          {
            type: "p",
            text: "Raut's [fleet tracking](/gps-trackers) gives each vehicle a live status, a daily trail with distance, stops and top speed, and an API so devices from other platforms can report into it. If a van's tracker goes quiet, its driver's phone can stand in, and the screen says which source you are looking at.",
          },
        ],
      },
      {
        heading: "Common mistakes",
        blocks: [
          {
            type: "ul",
            items: [
              "Treating a speed governor as a tracker. NTSA's speed governor rules for public service vehicles are a separate compliance matter from fleet tracking.",
              "Choosing on device price alone and discovering the monthly airtime later.",
              "Fitting a tracker where any mechanic can find and unplug it.",
              "Never looking at the data. A tracker only saves money if someone reads the reports.",
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: "Do GPS tracking companies in Kenya need a licence?",
        a: "Yes. The Communications Authority says vehicle tracking and fleet management providers must be licensed, and has warned businesses to verify a provider's licence and Annual Compliance Certificate before using it.",
      },
      {
        q: "How do I check if a tracking company is licensed?",
        a: "Check the Communications Authority's licence register online, or contact the Authority directly, and ask the company for its current Annual Compliance Certificate.",
      },
      {
        q: "Can I fit a GPS tracker to my own company vehicles?",
        a: "Using a licensed provider is the straightforward route. The Authority says firms that run tracking services in-house need a direct licence, and drivers' location data also falls under the Data Protection Act.",
      },
      {
        q: "Does a tracker work without network coverage?",
        a: "It depends on the device. Many store positions and send them when signal returns, so ask the seller to confirm this and test it across a route you know has gaps.",
      },
    ],
    sources: [
      { label: "Kenyans.co.ke, CA warns against use of unlicensed vehicle tracking service providers", url: "https://www.kenyans.co.ke/news/114179-ca-warns-against-use-unlicensed-vehicle-tracking-service-providers", date: "15 July 2025" },
      { label: "Communications Authority public notice on radio and telecommunications terminal equipment", url: "https://gaa.go.ke/sites/default/files/2024-10/Communications%20Authority%20of%20Kenya%20-%20Public%20Notice%20on%20Radio%20and%20Telecommunications%20Terminal%20Equipment%20.pdf" },
      { label: "AllAfrica, NTSA warns PSV operators against tampering with speed governors", url: "https://allafrica.com/stories/202512220083.html", date: "22 December 2025" },
    ],
    related: ["m2m-sim-cards-gps-trackers-kenya", "gps-tracking-drivers-data-protection-kenya", "cargo-theft-northern-corridor-2026"],
  },
  {
    slug: "m2m-sim-cards-gps-trackers-kenya",
    title: "M2M SIM Cards for GPS Trackers in Kenya: A Fleet Guide",
    headline: "M2M SIM cards for GPS trackers in Kenya: what fleet owners should know",
    description:
      "What SIM should go in a GPS tracker? How M2M and IoT SIMs differ from phone lines in Kenya, the registration rules, and what to ask before you buy.",
    cluster: "buying",
    primaryKeyword: "M2M SIM card Kenya",
    keywords: ["GPS tracker SIM card", "IoT SIM Kenya", "SIM card for car tracker", "tracker airtime Kenya", "M2M SIM registration"],
    publishedAt: PUBLISHED,
    updatedAt: PUBLISHED,
    intro:
      "The SIM is the part of a tracker nobody thinks about until the map goes blank. A van that stops reporting because its bundle expired looks exactly like a van that has been stolen. Choosing and managing tracker SIMs properly removes that false alarm, and keeps you within the rules.",
    keyTakeaways: [
      "A tracker needs little data but needs it reliably, so plan for a line that never quietly lapses.",
      "SIMs in Kenya must be registered, including those in machines, so make sure you know whose name each one is in.",
      "Keep a record matching each SIM number to each device and vehicle.",
    ],
    sections: [
      {
        heading: "What makes a tracker SIM different",
        blocks: [
          {
            type: "p",
            text: "A phone line is built around a person who notices when airtime runs out. A tracker sits behind a dashboard and tells nobody. It sends small amounts of data all day, so what matters is not bundle size but that the line stays active, on a network that covers your routes, and that someone is alerted when it does not.",
          },
          {
            type: "table",
            caption: "Phone SIM compared with a managed tracker SIM",
            headers: ["Question", "Ordinary phone SIM", "Managed tracker SIM"],
            rows: [
              ["When the bundle ends", "The line goes quiet and no one is told", "Should be renewed centrally for the whole fleet"],
              ["Who holds the records", "Often a staff member's name", "The business or its provider, on record"],
              ["If a driver takes it out", "It works in any phone", "Ask the provider whether it can be locked to data or to the device"],
              ["Billing", "Many separate top-ups", "One account across all vehicles"],
            ],
          },
        ],
      },
      {
        heading: "The rules on SIMs in machines",
        blocks: [
          {
            type: "p",
            text: "The Communications Authority's guidelines on Internet of Things devices cover devices with embedded SIMs, and say these devices need type approval and subscriber registration under the SIM registration regulations. In other words a SIM in a machine is not outside the system. Revised SIM rules were published in 2025, and the Authority has since clarified how they apply.",
          },
          {
            type: "note",
            text: "This is general guidance rather than legal advice. Ask your provider how your lines are registered, and confirm anything you depend on with the Communications Authority.",
          },
        ],
      },
      {
        heading: "Questions to ask before buying tracker SIMs",
        blocks: [
          {
            type: "ol",
            items: [
              "Which network or networks does it use, and how is coverage on my actual routes?",
              "Whose name is each line registered in, and can I see that record?",
              "What happens when data runs out, and who gets told?",
              "Does it work across the border? If you run to Uganda, Rwanda, Tanzania or South Sudan, ask for roaming terms in writing.",
              "Is the SIM restricted to data, so it cannot be misused in a phone?",
              "Can I see all my lines and their status in one place?",
            ],
          },
        ],
      },
      {
        heading: "Keep the record straight",
        blocks: [
          {
            type: "p",
            text: "Most tracker headaches are paperwork problems. Keep one list with each device ID, its SIM number, the vehicle it is in and the date it was fitted. When a van is sold or a tracker moved, update it that day. In Raut, each device is matched to a vehicle, and a device reporting without a vehicle shows up as waiting to be assigned rather than disappearing.",
          },
          {
            type: "p",
            text: "We supply [tracking devices together with tracker SIM cards](/gps-trackers), so one supplier answers for the hardware, the line and the software. Whoever you buy from, the checks in our [GPS tracking buyer's guide](/blog/gps-tracking-kenya-buyers-guide) still apply.",
          },
        ],
      },
    ],
    faq: [
      {
        q: "Can I use a normal Safaricom or Airtel line in a GPS tracker?",
        a: "Technically many trackers accept an ordinary data SIM, but the line must still be properly registered, and a consumer bundle that lapses silently will stop the tracker. Ask whether a managed line suits a fleet better.",
      },
      {
        q: "How much data does a GPS tracker use?",
        a: "Usually very little, since each position is a small message, but it varies with how often the device reports. Ask your supplier for the figure for your device and reporting interval.",
      },
      {
        q: "Do SIM cards in trackers need to be registered in Kenya?",
        a: "The Communications Authority's IoT guidelines say activating these devices requires subscriber registration under the SIM registration regulations. Confirm whose name your lines are registered in.",
      },
    ],
    sources: [
      { label: "Communications Authority, Guidelines on the use of Internet of Things devices", url: "https://www.ca.go.ke/sites/default/files/2023-06/Guidelines-on-the-use-of-Internet-of-Things-IoT-Devices.pdf" },
      { label: "Tech Africa News, CA clarifies new SIM rules", url: "https://techafricanews.com/2025/11/18/kenyas-communications-authority-clarifies-new-sim-rules-amid-public-concern/", date: "18 November 2025" },
      { label: "Kenyans.co.ke, CA warns against unlicensed vehicle tracking providers", url: "https://www.kenyans.co.ke/news/114179-ca-warns-against-use-unlicensed-vehicle-tracking-service-providers", date: "15 July 2025" },
    ],
    related: ["gps-tracking-kenya-buyers-guide", "cargo-theft-northern-corridor-2026", "logistics-trends-kenya-east-africa-2026"],
  },
  {
    slug: "cargo-theft-northern-corridor-2026",
    title: "Cargo Theft on the Northern Corridor: 2026 Lessons",
    headline: "Cargo theft on the Northern Corridor: what 2026 has taught transporters",
    description:
      "Security alerts and arrests on the Mombasa to Malaba route in 2026 show why one seal is not enough. Practical ways to protect drivers and cargo in Kenya.",
    cluster: "security",
    primaryKeyword: "cargo theft Kenya",
    keywords: ["truck tracking Mombasa Nairobi", "Northern Corridor security", "hijacking Kenya trucks", "fuel siphoning Kenya", "fleet security Kenya"],
    publishedAt: PUBLISHED,
    updatedAt: PUBLISHED,
    intro:
      "Moving cargo from Mombasa to the border and beyond takes days, and the driver is alone for much of it. Reports during 2026 have put highway security back in front of transport owners. No device makes a truck safe by itself, but the reported incidents point to what a sensible, layered approach looks like.",
    keyTakeaways: [
      "A security firm issued a transporter alert in January 2026 about theft and hijacking on the Malaba to Mombasa route, advising against night travel on high-risk sections.",
      "In one reported case a customs tracking seal was disabled, so do not rely on a single device.",
      "A second, independent tracker that alerts your own office gives you an early signal that is yours to act on.",
    ],
    sections: [
      {
        heading: "What has been reported",
        blocks: [
          {
            type: "p",
            text: "In January 2026 a driver carrying coffee from Uganda to Mombasa was found dead near Burnt Forest in Uasin Gishu County, and the cargo was missing. Police were investigating, and reports said investigators were looking at how the customs tracking seal came to be disabled, and why the transport company was not alerted sooner. Our thoughts are with those affected, and the facts of that case are for the investigators to establish.",
          },
          {
            type: "p",
            text: "SGA Security Kenya, which monitors container movements between Malaba and Mombasa, advised drivers on 23 January to avoid night travel on high-risk sections, naming Turbo to Webuye and Eldoret to Mau Summit, after what it described as a rise in theft and hijacking. Days earlier, police had arrested suspects linked to attacks on truck drivers on the Nairobi to Mombasa highway.",
          },
        ],
      },
      {
        heading: "Why one layer is not enough",
        blocks: [
          {
            type: "p",
            text: "KRA's cargo tracking system is designed to protect customs revenue: it watches the cargo's route, not your business's interests. It is valuable, and KRA reports that it flags deviations from a corridor typically within 100 metres of the designated route. But the alert goes to customs first, and your own office may hear later. That gap is what a separate fleet tracker closes.",
          },
          {
            type: "table",
            caption: "Customs e-seal compared with your own fleet tracker",
            headers: ["", "Customs e-seal", "Your own fleet tracker"],
            rows: [
              ["Purpose", "Protects customs control of transit goods", "Protects your truck, cargo and driver"],
              ["Who watches it", "KRA and its vendor", "You"],
              ["When it applies", "Goods under customs control", "All the time, loaded or empty"],
              ["Fitted to", "The cargo or container", "The vehicle"],
            ],
          },
        ],
      },
      {
        heading: "A practical security plan",
        blocks: [
          {
            type: "ol",
            items: [
              "Plan day-time running through the sections security firms name as high risk, and agree safe overnight stops in advance.",
              "Fit an independent tracker in a concealed position, separate from any customs seal.",
              "Decide who watches. A tracker nobody looks at after hours protects nobody, so name a person for nights and weekends.",
              "Treat a silent tracker as an event. A device that stops reporting on a highway needs a phone call now, not a report tomorrow.",
              "Give drivers a way to check in, and make it clear that their safety comes before the cargo.",
              "Keep trip records, which insurers and investigators will ask for.",
            ],
          },
        ],
      },
      {
        heading: "How tracking helps, honestly",
        blocks: [
          {
            type: "p",
            text: "A tracker does not stop a determined attack. What it does is shorten the time between something going wrong and someone knowing, and leave a clear record afterwards. On Raut's [fleet map](/gps-trackers), a vehicle that goes quiet moves to offline rather than quietly keeping its last position as if nothing had changed, and each day's trail and stops stay on file for that vehicle.",
          },
          {
            type: "p",
            text: "Fuel theft follows the same logic. Reports of siphoning on Kenyan highways go back years, and an unexplained stop on the trail is often the first clue. See our [guide to fleet fuel costs](/blog/diesel-price-fleet-fuel-costs-kenya).",
          },
        ],
      },
    ],
    faq: [
      {
        q: "Which Northern Corridor sections are considered high risk?",
        a: "In January 2026 SGA Security Kenya named Turbo to Webuye and Eldoret to Mau Summit in its advice to avoid night travel. Risk changes, so check current advisories from your security provider.",
      },
      {
        q: "Is a KRA e-seal enough to protect my cargo?",
        a: "It protects customs control of transit goods and alerts the customs system. Many transporters also run an independent tracker so that their own office receives an alert directly.",
      },
      {
        q: "Can a GPS tracker prevent hijacking?",
        a: "No device can prevent an attack. A tracker shortens the time before you know something is wrong and leaves a record for recovery, insurers and investigators.",
      },
    ],
    sources: [
      { label: "Mwakilishi, truck driver found dead as cargo vanishes near Burnt Forest", url: "https://mwakilishi.com/amp/node/373416", date: "28 January 2026" },
      { label: "AllAfrica, 3 arrested in crackdown on highway robbery gang along Mombasa Road", url: "https://allafrica.com/stories/202601190430.html", date: "19 January 2026" },
      { label: "Kenyans.co.ke, how KRA's real-time cargo tracking monitors transit trucks", url: "https://www.kenyans.co.ke/news/123773-kra-explains-how-real-time-cargo-tracking-system-monitors-transit-trucks-mombasa", date: "26 May 2026" },
      { label: "Nation, fuel siphoning on highway blamed on police and cartels", url: "https://nation.africa/kenya/news/fuel-siphoning-on-highway-blamed-on-police-and-cartels-182192" },
      { label: "The Star, police bust fuel siphoning syndicates in Mombasa", url: "https://www.the-star.co.ke/news/2025-05-29-police-bust-fuel-siphoning-syndicates-in-mombasa", date: "29 May 2025" },
    ],
    related: ["kra-rects-user-owned-e-seals-transporters", "gps-tracking-kenya-buyers-guide", "diesel-price-fleet-fuel-costs-kenya"],
  },
  {
    slug: "diesel-price-fleet-fuel-costs-kenya",
    title: "Diesel at KSh 227: Cutting Fleet Fuel Costs in Kenya",
    headline: "Diesel at KSh 227 a litre: how Kenyan fleets can spend less on fuel",
    description:
      "With Nairobi diesel capped at KSh 227.76, here is how Kenyan fleets can measure fuel use per vehicle and find waste from idling, detours and siphoning.",
    cluster: "costs",
    primaryKeyword: "fleet fuel costs Kenya",
    keywords: ["diesel price Kenya", "EPRA fuel prices", "reduce fuel consumption fleet", "fuel management Kenya", "fuel theft trucks Kenya"],
    publishedAt: PUBLISHED,
    updatedAt: PUBLISHED,
    intro:
      "You cannot control EPRA's price review. You can control how many kilometres your vehicles drive, how long they sit with the engine running, and whether the fuel you pay for reaches the tank. All three need the same thing first: a number per vehicle, per month.",
    keyTakeaways: [
      "EPRA capped Nairobi diesel at KSh 227.76 a litre for 15 October to 14 November 2026. Check the latest review, since prices change monthly.",
      "Work out kilometres per litre for each vehicle, then investigate the ones that stand out.",
      "Compare distance driven against fuel bought, since a gap between the two is where waste shows up.",
    ],
    sections: [
      {
        heading: "Where the price stands",
        blocks: [
          {
            type: "p",
            text: "Diesel hit a record of more than KSh 242 a litre in Nairobi in May 2026. A cut followed in August, and in the October review diesel rose by KSh 9.90 to KSh 227.76, with EPRA attributing the increase to import costs. Each monthly review changes the sums, so build your costing around litres used and not around a price you hope will hold.",
          },
        ],
      },
      {
        heading: "Measure before you manage",
        blocks: [
          {
            type: "p",
            text: "The single most useful fleet number is fuel efficiency by vehicle: kilometres driven divided by litres bought. You need reliable distance and fuel records to get it, and odometer readings written down by hand tend to drift. GPS distance gives you an independent figure to compare them with.",
          },
          {
            type: "table",
            caption: "Example fuel cost per trip at KSh 227.76 a litre (illustrative figures, not a benchmark)",
            headers: ["Trip distance", "If a truck does 3 km per litre", "If it does 3.5 km per litre", "Difference per trip"],
            rows: [
              ["480 km", "160 litres, KSh 36,442", "137 litres, KSh 31,236", "KSh 5,206"],
              ["1,000 km", "333 litres, KSh 75,920", "286 litres, KSh 65,074", "KSh 10,846"],
            ],
          },
          {
            type: "p",
            text: "These numbers are illustrations of how the arithmetic works. Use your own vehicles' figures, since consumption varies widely with load, road and vehicle.",
          },
        ],
      },
      {
        heading: "Four places fuel disappears",
        blocks: [
          {
            type: "ul",
            items: [
              "**Extra kilometres.** Compare planned distance with driven distance. Detours and missed turnings add up over a month.",
              "**Idling.** An engine running in a queue burns diesel and moves nothing. Trackers wired to ignition can tell idling from parking.",
              "**Harsh driving.** High speeds raise consumption, so check top speeds on the trail with the driver, not just after an accident.",
              "**Theft.** Siphoning has been reported on Kenyan highways for years. An unplanned stop that lines up with a poor fuel figure is worth a conversation.",
            ],
          },
        ],
      },
      {
        heading: "Turn it into a monthly habit",
        blocks: [
          {
            type: "ol",
            items: [
              "At month end, pull distance per vehicle and fuel bought per vehicle.",
              "Rank vehicles by kilometres per litre, and compare like with like.",
              "Look at the trail for the worst two: long stops, detours, top speeds.",
              "Talk to the drivers. Sometimes the answer is a tired engine or a bad route and not behaviour.",
              "Check whether the figure moved the next month.",
            ],
          },
          {
            type: "p",
            text: "Raut's vehicle utilisation report shows distance, hours moving, days out and top speed per vehicle for any period, and each vehicle has a [daily trail](/gps-trackers) with stops. Raut does not read fuel-level sensors, so fuel figures come from your purchase records. Expenses recorded in Raut can be reported by category alongside these numbers. If you are choosing hardware, our [GPS tracking buyer's guide](/blog/gps-tracking-kenya-buyers-guide) covers what to ask.",
          },
        ],
      },
    ],
    faq: [
      {
        q: "How often does the diesel price change in Kenya?",
        a: "EPRA reviews pump prices monthly, with each cycle running from the 15th to the 14th of the next month. The figure here applied to 15 October to 14 November 2026.",
      },
      {
        q: "Can a GPS tracker reduce fuel costs?",
        a: "Not by itself. It shows distance, stops and speed so you can find waste. The saving comes from acting on those findings, and it varies by fleet, so be wary of any guaranteed percentage.",
      },
      {
        q: "How can I tell if fuel is being stolen from my trucks?",
        a: "Compare fuel bought with distance driven per vehicle, then look for unplanned stops on the trail. Fuel-level sensors give more direct evidence, so ask your tracker supplier whether your device supports them.",
      },
    ],
    sources: [
      { label: "Tech-ish, EPRA October 2026 fuel review", url: "https://tech-ish.com/2026/10/14/petrol-rises-to-kes-226-96-in-nairobi-and-kerosene-jumps-kes-28-49/", date: "14 October 2026" },
      { label: "The Standard, diesel hits record Sh242", url: "https://www.standardmedia.co.ke/business/amp/national/article/2001547862/fuel-price-shocker-diesel-hits-record-sh242-as-pump-prices-jump-in-latest-epra-review" },
      { label: "Kenyans.co.ke, EPRA cuts diesel price by Ksh5", url: "https://www.kenyans.co.ke/news/126194-epra-cuts-diesel-price-ksh5-keeps-petrol-and-kerosene-prices-unchanged-until-september" },
      { label: "Nation, fuel siphoning on highway blamed on police and cartels", url: "https://nation.africa/kenya/news/fuel-siphoning-on-highway-blamed-on-police-and-cartels-182192" },
    ],
    related: ["gps-tracking-kenya-buyers-guide", "cargo-theft-northern-corridor-2026", "logistics-trends-kenya-east-africa-2026"],
  },
  {
    slug: "kra-rects-user-owned-e-seals-transporters",
    title: "KRA's User-Owned E-Seals: What Transporters Must Do",
    headline: "KRA's user-owned e-seals: what importers and transporters need to do",
    description:
      "KRA has replaced its own cargo seals with user-owned e-seals from 15 approved vendors. What RECTS is, what changed in 2026, and how to choose a vendor.",
    cluster: "compliance",
    primaryKeyword: "KRA electronic cargo tracking seals",
    keywords: ["RECTS Kenya", "user-owned e-seals", "Regional Electronic Cargo Tracking System", "KRA approved seal vendors", "transit cargo tracking Kenya"],
    publishedAt: PUBLISHED,
    updatedAt: PUBLISHED,
    intro:
      "For years, KRA supplied the electronic seals that track transit cargo. That is changing. Under a new model, the people moving goods choose and contract an approved private vendor for their seals, which brings a new buying decision and new costs to plan for.",
    keyTakeaways: [
      "KRA announced a Multi-Vendor, User-Owned Seals model, with the transition scheduled for completion by 26 October 2026.",
      "15 vendors are approved, covering dry cargo e-seals and wet cargo e-fuel seals.",
      "A regulatory e-seal and a fleet tracker do different jobs. Do not assume one replaces the other.",
    ],
    sections: [
      {
        heading: "What RECTS does",
        blocks: [
          {
            type: "p",
            text: "The Regional Electronic Cargo Tracking System watches goods moving under customs control. KRA says it creates a geo-fenced corridor, typically within 100 metres of the designated route, and that a deviation triggers an alert. It also records where a truck stopped and for how long.",
          },
          {
            type: "p",
            text: "To use it, transporters are onboarded onto KRA's iCMS as compliant transit operators, vehicles are profiled and cleared, and drivers need a special KRA licence for transit cargo. Shipment, driver and company details are verified before a device is issued, and for a breakdown the operator notifies KRA and gets authorisation to change route.",
          },
        ],
      },
      {
        heading: "What changed in 2026",
        blocks: [
          {
            type: "ul",
            items: [
              "KRA issued a public notice on 11 September 2026 phasing out its own seals, according to Kenyans.co.ke. A later report refers to a notice in October, so check KRA's website for the authoritative text.",
              "After the transition date of 26 October, goods under customs control are to be tracked only with devices from approved vendors.",
              "Importers, exporters, clearing and forwarding agents, transporters and bonded warehouse operators can each choose their preferred vendor.",
              "The arrangement runs on private commercial agreements between vendors and users.",
              "KRA's pre-qualification notice says vendors own and maintain the seals and remain accountable to KRA for their performance and integrity.",
            ],
          },
        ],
      },
      {
        heading: "How to choose an approved vendor",
        blocks: [
          {
            type: "p",
            text: "Start with the approved list on KRA's website or from its Cargo Monitoring Unit, because a seal from anyone else will not do. Then compare vendors on the things that affect your trips:",
          },
          {
            type: "ol",
            items: [
              "Price per trip or per seal, and what is included when a seal is lost or damaged.",
              "Whether they cover your routes and border points, and where their collection and return points are.",
              "How quickly they respond when a seal fails on the road.",
              "Who is liable for goods if a seal fails to report a problem. One report says vendors may be jointly liable, so read your contract closely.",
              "Dry cargo, wet cargo or both, if you carry fuel.",
            ],
          },
          {
            type: "note",
            text: "Confirm every requirement against KRA's current notice and with your clearing agent. Reports of the dates differ between sources, and rules can change.",
          },
        ],
      },
      {
        heading: "An e-seal is not a fleet tracker",
        blocks: [
          {
            type: "p",
            text: "A customs seal travels with a consignment and exists to satisfy customs. KRA has said each device lasts around 60 days. A fleet tracker stays with your vehicle all year, including empty return legs, and reports to you. We set out the differences in our [Northern Corridor security analysis](/blog/cargo-theft-northern-corridor-2026).",
          },
          {
            type: "p",
            text: "[Raut's GPS trackers and software](/gps-trackers) are fleet tools for your own operations. They are not a customs seal and do not replace your RECTS obligations.",
          },
        ],
      },
    ],
    faq: [
      {
        q: "What is RECTS?",
        a: "The Regional Electronic Cargo Tracking System is the framework KRA and regional revenue authorities use to monitor transit goods under customs control, using electronic seals and route geofencing.",
      },
      {
        q: "Can I still use a KRA-owned seal?",
        a: "KRA's transition to approved vendors was scheduled for completion by 26 October 2026. Check the current notice on KRA's website or with the Cargo Monitoring Unit.",
      },
      {
        q: "How many e-seal vendors has KRA approved?",
        a: "Reports in September 2026 say KRA approved 15 vendors. The current list is available from KRA's website and customs offices.",
      },
      {
        q: "Does a GPS tracker meet KRA's e-seal requirement?",
        a: "No. Goods under customs control must use a device from a KRA-approved vendor. An ordinary fleet tracker does a different job for your own business.",
      },
    ],
    sources: [
      { label: "Kenyans.co.ke, KRA to replace its cargo tracking seals with new vendor system", url: "https://www.kenyans.co.ke/news/126981-kra-replace-its-cargo-tracking-seals-new-vendor-system-october-26", date: "11 September 2026" },
      { label: "KRA, pre-qualification of vendors for electronic seals through a multi-vendor framework", url: "https://www.kra.go.ke/news-center/public-notices/2358-pre-qualification-of-vendors-for-supply,-operation,maintenance-and-managed-services-of-electronic-seals-through-a-multi-vendor-framework" },
      { label: "Kenyans.co.ke, how KRA's real-time cargo tracking monitors transit trucks", url: "https://www.kenyans.co.ke/news/123773-kra-explains-how-real-time-cargo-tracking-system-monitors-transit-trucks-mombasa", date: "26 May 2026" },
      { label: "The Kenya Times, importers get more choice under new KRA cargo tracking plan", url: "https://thekenyatimes.com/latest-kenya-times-news/importers-get-more-choice-under-new-kra-cargo-tracking-plan/", date: "27 October 2026" },
    ],
    related: ["cargo-theft-northern-corridor-2026", "logistics-trends-kenya-east-africa-2026", "gps-tracking-kenya-buyers-guide"],
  },
  {
    slug: "gps-tracking-drivers-data-protection-kenya",
    title: "GPS Tracking Drivers in Kenya: Data Protection Guide",
    headline: "Tracking your drivers in Kenya: staying on the right side of data protection",
    description:
      "Is it legal to GPS track drivers in Kenya? What the Data Protection Act and the ODPC's 2026 draft transport guidance mean for fleet owners and employers.",
    cluster: "compliance",
    primaryKeyword: "GPS tracking employees Kenya",
    keywords: ["Data Protection Act Kenya fleet", "ODPC transport guidance", "driver tracking privacy Kenya", "employee location data Kenya"],
    publishedAt: PUBLISHED,
    updatedAt: PUBLISHED,
    intro:
      "A tracker on a company truck records a vehicle, but it also records a person: where the driver went and when. In Kenya that makes it personal data under the Data Protection Act, 2019. Fleets can still track, and many have good reasons to, but doing it properly takes more than fitting a device.",
    keyTakeaways: [
      "The Data Protection Act, 2019 applies to personal data of Kenyan residents, which includes your staff.",
      "The ODPC's April 2026 draft transport guidance calls real-time location tracking a significant privacy concern.",
      "Tell drivers, limit what you collect, restrict who sees it and delete it when it is no longer needed.",
    ],
    sections: [
      {
        heading: "Why fleet tracking is a data protection question",
        blocks: [
          {
            type: "p",
            text: "In April 2026 the Office of the Data Protection Commissioner published draft guidance for the transport sector, covering operators including matatu SACCOs, taxi-hailing platforms, aviation and maritime firms. Reports describe the processing of location data as a central concern. Under the proposals, transport operators acting as data controllers or processors would register with the ODPC, many would appoint Data Protection Officers, and firms using high-risk technology such as dash-cams and automated driver rating would carry out Data Protection Impact Assessments.",
          },
          {
            type: "note",
            text: "This guidance was in draft, with feedback open until 15 May 2026. We could not confirm a final version, so check with the ODPC. This article is general information and not legal advice, so speak to a Kenyan data protection lawyer about your own fleet.",
          },
        ],
      },
      {
        heading: "Principles to build your policy around",
        blocks: [
          {
            type: "ul",
            items: [
              "**Be transparent.** The draft guidance expects companies to explain their data use in plain language, so tell drivers what is tracked, when and why, in writing.",
              "**Have a clear purpose.** Asset security, route planning and proof of delivery are concrete purposes. Vague monitoring is not.",
              "**Collect only what you need.** More data is more risk to look after.",
              "**Limit retention.** The draft says data should be deleted or anonymised once its purpose has been fulfilled, so decide how long you keep trails and stick to it.",
              "**Restrict access.** Dispatchers may need a live map. Not everyone needs last year's trail.",
              "**Think about private use.** If drivers may use a vehicle out of hours, decide what happens to tracking then. Take advice on this one in particular.",
            ],
          },
        ],
      },
      {
        heading: "A short checklist",
        blocks: [
          {
            type: "ol",
            items: [
              "Check whether you must register as a data controller.",
              "Write a one-page tracking policy, and share it with every driver.",
              "Update employment contracts or staff handbooks if your lawyer advises it.",
              "Set a retention period for location data.",
              "Decide who can see what, and review it when people change roles.",
              "Consider a Data Protection Impact Assessment, especially if you rate drivers automatically.",
              "Choose suppliers who can explain how they secure your data.",
            ],
          },
        ],
      },
      {
        heading: "How Raut supports this",
        blocks: [
          {
            type: "p",
            text: "Raut's roles decide who sees location data. A field rep sees only the van they drive, managers see the fleet, and accountants do not see it at all. Tracker keys are stored in hashed form and each company's data is kept separate. Tools help, but they do not replace your own policy. Learn more about [Raut's fleet tracking](/gps-trackers), and read our [buyer's guide](/blog/gps-tracking-kenya-buyers-guide) for the licensing side.",
          },
        ],
      },
    ],
    faq: [
      {
        q: "Is it legal to track employees with GPS in Kenya?",
        a: "We found no Kenyan rule that bans fleet tracking outright, but location data about a driver is personal data under the Data Protection Act, 2019, so you need a proper basis and must handle it lawfully. Take legal advice on your circumstances.",
      },
      {
        q: "Do I need to tell drivers they are being tracked?",
        a: "Transparency is a core principle, and the ODPC's draft transport guidance expects companies to explain their data use in plain language. Telling drivers in writing is the sensible baseline.",
      },
      {
        q: "How long can I keep GPS location data?",
        a: "The draft guidance says data should be deleted or anonymised once its purpose has been fulfilled. There is no universal period, so set one that matches your purpose and any legal or insurance needs.",
      },
    ],
    sources: [
      { label: "Radio Generation, ODPC unveils draft transport data rules", url: "https://radiogeneration.co.ke/news/83869/odpc-unveils-draft-transport-data-rules-to-tighten-privacy-controls-in-kenya", date: "15 April 2026" },
      { label: "Rödl & Partner, Kenya: employees' data and the Data Protection Act", url: "https://roedl.com/insights/kenya-employees-data-protection-act" },
      { label: "Bowmans, data protection in Kenyan employment", url: "https://www.bowmanslaw.com/insights/employment/kenya-data-protection-in-kenya-employment/" },
      { label: "Office of the Data Protection Commissioner", url: "https://www.odpc.go.ke/who-we-are/" },
    ],
    related: ["gps-tracking-kenya-buyers-guide", "m2m-sim-cards-gps-trackers-kenya", "kra-rects-user-owned-e-seals-transporters"],
  },
];

export function postBySlug(slug: string): BlogPost | undefined {
  return POSTS.find((post) => post.slug === slug);
}

/** Roughly how long an article takes, at an average 200 words a minute. */
export function readingMinutes(post: BlogPost): number {
  const words = [
    post.intro,
    ...post.keyTakeaways,
    ...post.sections.flatMap((s) => [
      s.heading,
      ...s.blocks.flatMap((b) => {
        switch (b.type) {
          case "p":
          case "note":
            return [b.text];
          case "table":
            return b.rows.flat();
          default:
            return b.items;
        }
      }),
    ]),
    ...post.faq.flatMap((f) => [f.q, f.a]),
  ]
    .join(" ")
    .split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}
