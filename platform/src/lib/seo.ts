import type { BlogPost } from "@/content/blog/posts";

/**
 * Everything search engines read about Raut, in one place: the canonical address,
 * the organisation behind it and the structured data each page publishes.
 */

export const SITE_NAME = "Raut";
export const ORGANISATION_NAME = "Tari Africa Platforms Limited";

/**
 * Sales contact. The WhatsApp number is optional and left to configuration, since
 * a wrong number on a public page loses every lead that uses it.
 */
export const SALES_EMAIL = process.env.NEXT_PUBLIC_SALES_EMAIL ?? "phinetechltd@gmail.com";
export const SALES_WHATSAPP = process.env.NEXT_PUBLIC_SALES_WHATSAPP ?? "";

export function siteUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://raut.co.ke";
  return raw.replace(/\/+$/, "");
}

export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function quoteMailto(subject = "GPS tracker and SIM card quote"): string {
  const body = [
    "Hello, I would like a quote for GPS tracking.",
    "",
    "Company:",
    "Number and type of vehicles:",
    "Main routes:",
    "Phone number:",
  ].join("\n");
  return `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function whatsappLink(message = "Hello, I would like a quote for GPS tracking."): string | null {
  const digits = SALES_WHATSAPP.replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

/**
 * JSON for a script tag. `<` is escaped because a `</script>` inside a string would
 * otherwise end the tag early, which is both a broken page and an injection risk.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function organisationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": absoluteUrl("/#organisation"),
    name: ORGANISATION_NAME,
    alternateName: SITE_NAME,
    url: siteUrl(),
    logo: absoluteUrl("/brand/raut-icon.png"),
    email: SALES_EMAIL,
    address: { "@type": "PostalAddress", addressLocality: "Nairobi", addressCountry: "KE" },
    areaServed: ["KE", "UG", "TZ", "RW"],
  };
}

export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": absoluteUrl("/#website"),
    name: SITE_NAME,
    url: siteUrl(),
    inLanguage: "en-KE",
    publisher: { "@id": absoluteUrl("/#organisation") },
  };
}

export function breadcrumbSchema(items: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function faqSchema(faq: Array<{ q: string; a: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

export function articleSchema(post: BlogPost, wordCount: number) {
  const url = absoluteUrl(`/blog/${post.slug}`);
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    headline: post.headline,
    description: post.description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    inLanguage: "en-KE",
    keywords: [post.primaryKeyword, ...post.keywords].join(", "),
    wordCount,
    image: absoluteUrl(`/blog/${post.slug}/opengraph-image`),
    author: { "@id": absoluteUrl("/#organisation"), "@type": "Organization", name: ORGANISATION_NAME },
    publisher: { "@id": absoluteUrl("/#organisation"), "@type": "Organization", name: ORGANISATION_NAME },
    citation: post.sources.map((s) => s.url),
    about: { "@type": "Thing", name: post.primaryKeyword },
    spatialCoverage: { "@type": "Place", name: "East Africa" },
  };
}

export function serviceSchema(faqDescription: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "GPS vehicle tracking, tracking devices and tracker SIM cards",
    serviceType: "Fleet GPS tracking",
    description: faqDescription,
    provider: { "@id": absoluteUrl("/#organisation"), "@type": "Organization", name: ORGANISATION_NAME },
    areaServed: { "@type": "Country", name: "Kenya" },
    url: absoluteUrl("/gps-trackers"),
  };
}

/** Pages that must never appear in search results. */
export const PRIVATE_PATHS = ["/app/", "/admin/", "/api/", "/print/", "/login"];
