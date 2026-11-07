import type { Metadata } from "next";
import Link from "next/link";

import { PublicChrome } from "@/components/public-chrome";
import { CLUSTERS, POSTS, readingMinutes, type Cluster } from "@/content/blog/posts";
import { absoluteUrl, breadcrumbSchema, jsonLd } from "@/lib/seo";

const DESCRIPTION =
  "Guides on GPS tracking, tracker SIM cards, cargo security, fuel costs and logistics compliance for fleets in Kenya and East Africa.";

export const metadata: Metadata = {
  title: { absolute: "Logistics and Fleet Tracking Blog for East Africa | Raut" },
  description: DESCRIPTION,
  alternates: {
    canonical: absoluteUrl("/blog"),
    types: { "application/rss+xml": absoluteUrl("/blog/rss.xml") },
  },
  openGraph: {
    type: "website",
    url: absoluteUrl("/blog"),
    title: "Logistics and Fleet Tracking Blog for East Africa",
    description: DESCRIPTION,
    siteName: "Raut",
    locale: "en_KE",
  },
};

const dateLabel = (iso: string) =>
  new Date(`${iso}T12:00:00+03:00`).toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" });

export default async function BlogIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string }>;
}) {
  const { topic } = await searchParams;
  const active = topic && topic in CLUSTERS ? (topic as Cluster) : null;
  const posts = active ? POSTS.filter((p) => p.cluster === active) : POSTS;

  return (
    <PublicChrome>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Blog", path: "/blog" }])),
        }}
      />
      <section className="afr-weave-dark bg-ink-950 text-white">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand-300">Barabara · The road ahead</p>
          <h1 className="font-display mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-4xl">
            Logistics and fleet tracking in Kenya and East Africa
          </h1>
          <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-white/80">{DESCRIPTION}</p>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-6 py-10">
        <nav aria-label="Topics" className="mb-8 flex flex-wrap gap-2 text-sm">
          <Link
            href="/blog"
            aria-current={active ? undefined : "page"}
            className={`rounded-full border px-3 py-1.5 ${active ? "border-border hover:bg-surface-hover" : "border-accent bg-accent text-white"}`}
          >
            All articles
          </Link>
          {(Object.keys(CLUSTERS) as Cluster[]).map((key) => (
            <Link
              key={key}
              href={`/blog?topic=${key}`}
              aria-current={active === key ? "page" : undefined}
              className={`rounded-full border px-3 py-1.5 ${active === key ? "border-accent bg-accent text-white" : "border-border hover:bg-surface-hover"}`}
            >
              {CLUSTERS[key].label}
            </Link>
          ))}
        </nav>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <article key={post.slug} className="afr-card flex flex-col rounded-xl border border-border bg-surface p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">{CLUSTERS[post.cluster].label}</p>
              <h2 className="font-display mt-2 text-lg font-semibold leading-snug">
                <Link href={`/blog/${post.slug}`} className="hover:text-accent">
                  {post.headline}
                </Link>
              </h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-content-secondary">{post.description}</p>
              <p className="mt-4 text-xs text-content-muted">
                <time dateTime={post.publishedAt}>{dateLabel(post.publishedAt)}</time> · {readingMinutes(post)} min read
              </p>
            </article>
          ))}
        </div>
      </div>
    </PublicChrome>
  );
}
