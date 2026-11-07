/**
 * Reads the public pages the way a search engine does and checks what it finds.
 *
 * A page can look perfect and still be invisible to search: a missing canonical,
 * broken structured data or a robots rule in the wrong place will not show on
 * screen. This also makes sure private pages stay out of search, and that the
 * login page offers no credentials on a production build.
 *
 *   node scripts/check-seo.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3200";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") ?? "" };
}

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const metaOf = (html, attr, name) => {
  const a = html.match(new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`));
  const b = html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${attr}="${name}"`));
  return decode((a ?? b)?.[1] ?? "");
};
const titleOf = (html) => decode(html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? "");
const canonicalOf = (html) => html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/)?.[1] ?? "";

function schemasOf(html) {
  const out = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      out.push(JSON.parse(match[1]));
    } catch {
      out.push({ "@type": "INVALID" });
    }
  }
  return out;
}

function checkPage(label, html, expect) {
  const title = titleOf(html);
  const description = metaOf(html, "name", "description");
  check(`${label}: title is ${title.length} characters, 60 at most`, title.length > 0 && title.length <= 60, title);
  check(`${label}: description is ${description.length} characters, within 110 to 160`, description.length >= 110 && description.length <= 160, description);
  check(`${label}: exactly one h1`, (html.match(/<h1[\s>]/g) ?? []).length === 1, String((html.match(/<h1[\s>]/g) ?? []).length));
  check(`${label}: has a canonical address`, canonicalOf(html).endsWith(expect.path), canonicalOf(html));
  check(`${label}: has social sharing tags`, Boolean(metaOf(html, "property", "og:title") && metaOf(html, "property", "og:url")));
  check(`${label}: declares the language`, /<html[^>]*lang="en-KE"/.test(html));
  check(`${label}: is not blocked from search`, !/content="[^"]*noindex/.test(html));
  const schemas = schemasOf(html);
  check(`${label}: structured data all parses`, schemas.length > 0 && !schemas.some((s) => s["@type"] === "INVALID"));
  for (const type of expect.schemas) {
    check(`${label}: publishes ${type} data`, schemas.some((s) => s["@type"] === type), schemas.map((s) => s["@type"]).join(", "));
  }
  check(`${label}: every image has alt text`, !/<img(?![^>]*\balt=)[^>]*>/.test(html));
}

async function main() {
  console.log("\n  Crawling rules");
  const robots = await get("/robots.txt");
  check("robots.txt is served", robots.status === 200);
  for (const path of ["/app/", "/admin/", "/api/", "/print/", "/login"]) {
    check(`robots.txt keeps ${path} out of search`, robots.text.includes(`Disallow: ${path}`));
  }
  check("robots.txt allows the public site", robots.text.includes("Allow: /"));
  check("robots.txt points to the sitemap", /Sitemap: https?:\/\/\S+\/sitemap\.xml/.test(robots.text));

  const sitemap = await get("/sitemap.xml");
  check("sitemap.xml is served", sitemap.status === 200 && sitemap.type.includes("xml"));
  const urls = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check("The sitemap lists the blog and tracker page", urls.some((u) => u.endsWith("/blog")) && urls.some((u) => u.endsWith("/gps-trackers")));
  check("The sitemap leaves out private pages", !urls.some((u) => /\/(app|admin|api|print)\//.test(u)));
  const articleUrls = urls.filter((u) => /\/blog\/[a-z0-9-]+$/.test(u));
  check("The sitemap lists articles", articleUrls.length >= 7, String(articleUrls.length));

  const rss = await get("/blog/rss.xml");
  check("The RSS feed is served", rss.status === 200 && rss.type.includes("xml"));
  check("The RSS feed lists every article", (rss.text.match(/<item>/g) ?? []).length === articleUrls.length);

  console.log("\n  Public pages");
  const blog = await get("/blog");
  check("The blog loads", blog.status === 200);
  checkPage("Blog", blog.text, { path: "/blog", schemas: ["Organization", "WebSite", "BreadcrumbList"] });
  const trackers = await get("/gps-trackers");
  check("The tracker page loads", trackers.status === 200);
  checkPage("Trackers", trackers.text, { path: "/gps-trackers", schemas: ["Service", "FAQPage", "BreadcrumbList"] });
  check("The tracker page asks for a quote", trackers.text.includes("mailto:"));

  console.log("\n  Articles");
  for (const url of articleUrls) {
    const path = new URL(url).pathname;
    const page = await get(path);
    const label = path.replace("/blog/", "");
    check(`${label}: loads`, page.status === 200, String(page.status));
    checkPage(label, page.text, { path, schemas: ["BlogPosting", "FAQPage", "BreadcrumbList"] });
    const posting = schemasOf(page.text).find((s) => s["@type"] === "BlogPosting");
    check(`${label}: has dates and an author`, Boolean(posting?.datePublished && posting?.dateModified && posting?.author?.name));
    check(`${label}: cites its sources`, (posting?.citation?.length ?? 0) >= 3);
    check(`${label}: uses headings in order`, /<h1[\s>][\s\S]*<h2[\s>]/.test(page.text));
    check(`${label}: links to the tracker page`, page.text.includes('href="/gps-trackers"'));
    const image = await fetch(`${BASE}${path}/opengraph-image`, { redirect: "manual" });
    check(`${label}: has a share image`, image.status === 200 && (image.headers.get("content-type") ?? "").startsWith("image/png"), String(image.status));
  }
  const missing = await get("/blog/no-such-article");
  check("An unknown article is a real 404", missing.status === 404, String(missing.status));

  console.log("\n  Internal links");
  const seen = new Set();
  for (const url of articleUrls.slice(0, articleUrls.length)) {
    const page = await get(new URL(url).pathname);
    for (const match of page.text.matchAll(/href="(\/(?:blog|gps-trackers|contact-us|policy)[^"#?]*)"/g)) seen.add(match[1]);
  }
  for (const href of seen) {
    const res = await fetch(`${BASE}${href}`, { redirect: "manual" });
    check(`${href} resolves`, res.status === 200, String(res.status));
  }

  console.log("\n  The design");
  const css = (await Promise.all(
    [...blog.text.matchAll(/href="(\/_next\/static\/css\/[^"]+)"/g)].map(async (m) => (await fetch(`${BASE}${m[1]}`)).text()),
  )).join("\n");
  check("The East African palette is in the stylesheet", css.includes("#a8441c") || css.includes("#A8441C"));
  check("The bead pattern is in the stylesheet", css.includes(".afr-band"));
  check("Articles use the bead band", blog.text.includes("afr-band"));

  console.log("\n  Sign-in page");
  const login = await get("/login");
  const production = process.env.EXPECT_PRODUCTION === "1";
  if (production) {
    check("A production login page shows no credentials", !/Raut@2026|admin@tariafrica|Demo accounts/.test(login.text));
  } else {
    check("The login page loads", login.status === 200);
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:\n${failures.map((f) => `    - ${f}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
