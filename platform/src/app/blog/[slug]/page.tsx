import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { PublicChrome } from "@/components/public-chrome";
import { CLUSTERS, POSTS, postBySlug, readingMinutes, type Block, type BlogPost } from "@/content/blog/posts";
import {
  absoluteUrl,
  articleSchema,
  breadcrumbSchema,
  faqSchema,
  jsonLd,
  ORGANISATION_NAME,
  quoteMailto,
  whatsappLink,
} from "@/lib/seo";

/** Prebuilt at deploy, so search engines get complete HTML straight away. */
export const dynamicParams = false;

export function generateStaticParams() {
  return POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = postBySlug(slug);
  if (!post) return {};
  const url = absoluteUrl(`/blog/${post.slug}`);
  return {
    title: { absolute: post.title },
    description: post.description,
    keywords: [post.primaryKeyword, ...post.keywords],
    authors: [{ name: ORGANISATION_NAME }],
    alternates: { canonical: url, languages: { "en-KE": url, "x-default": url } },
    robots: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" },
    openGraph: {
      type: "article",
      url,
      title: post.title,
      description: post.description,
      siteName: "Raut",
      locale: "en_KE",
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      section: CLUSTERS[post.cluster].label,
      tags: post.keywords,
    },
    twitter: { card: "summary_large_image", title: post.title, description: post.description },
  };
}

/** Turns [text](url) and **bold** into elements. Only https and site-relative links. */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[3]) {
      parts.push(<strong key={key++}>{match[3]}</strong>);
    } else if (match[2].startsWith("/")) {
      parts.push(
        <Link key={key++} href={match[2]} className="font-medium text-accent underline underline-offset-2">
          {match[1]}
        </Link>,
      );
    } else if (match[2].startsWith("https://")) {
      parts.push(
        <a key={key++} href={match[2]} rel="noopener" className="font-medium text-accent underline underline-offset-2">
          {match[1]}
        </a>,
      );
    } else {
      parts.push(match[1]);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "p":
      return <p className="mt-4 leading-relaxed text-content-secondary"><Inline text={block.text} /></p>;
    case "note":
      return (
        <aside className="afr-note mt-5 rounded-lg border border-border bg-surface-sunken p-4 text-sm leading-relaxed text-content-secondary">
          <Inline text={block.text} />
        </aside>
      );
    case "ul":
    case "ol": {
      const Tag = block.type;
      return (
        <Tag className={`mt-4 space-y-2 pl-5 leading-relaxed text-content-secondary ${block.type === "ul" ? "list-disc" : "list-decimal"}`}>
          {block.items.map((item) => (
            <li key={item}><Inline text={item} /></li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="mt-5 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="caption-bottom px-3 py-2 text-left text-xs text-content-muted">{block.caption}</caption>
            <thead className="bg-surface-sunken">
              <tr>
                {block.headers.map((header, index) => (
                  <th key={index} scope="col" className="px-3 py-2 text-left font-semibold">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-t border-border">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-2 align-top text-content-secondary">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

const headingId = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const dateLabel = (iso: string) =>
  new Date(`${iso}T12:00:00+03:00`).toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" });

function wordCountOf(post: BlogPost): number {
  return readingMinutes(post) * 200;
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = postBySlug(slug);
  if (!post) notFound();

  const related = post.related.flatMap((s) => {
    const found = postBySlug(s);
    return found ? [found] : [];
  });
  const whatsapp = whatsappLink();
  const schema = [
    articleSchema(post, wordCountOf(post)),
    breadcrumbSchema([
      { name: "Home", path: "/" },
      { name: "Blog", path: "/blog" },
      { name: post.title, path: `/blog/${post.slug}` },
    ]),
    faqSchema(post.faq),
  ];

  return (
    <PublicChrome>
      {schema.map((item, index) => (
        <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(item) }} />
      ))}

      <article>
        <header className="afr-weave-dark bg-ink-950 text-white">
          <div className="mx-auto max-w-3xl px-6 py-12">
            <nav aria-label="Breadcrumb" className="text-sm text-white/75">
              <ol className="flex flex-wrap gap-1.5">
                <li><Link href="/" className="hover:text-white">Home</Link> <span aria-hidden="true">/</span></li>
                <li><Link href="/blog" className="hover:text-white">Blog</Link> <span aria-hidden="true">/</span></li>
                <li><Link href={`/blog?topic=${post.cluster}`} className="hover:text-white">{CLUSTERS[post.cluster].label}</Link></li>
              </ol>
            </nav>
            <h1 className="font-display mt-4 text-3xl font-semibold leading-tight sm:text-4xl">{post.headline}</h1>
            <p className="mt-4 text-sm text-white/75">
              By {ORGANISATION_NAME} · Published <time dateTime={post.publishedAt}>{dateLabel(post.publishedAt)}</time>
              {post.updatedAt !== post.publishedAt ? (
                <> · Updated <time dateTime={post.updatedAt}>{dateLabel(post.updatedAt)}</time></>
              ) : null}{" "}
              · {readingMinutes(post)} min read
            </p>
          </div>
        </header>

        <div className="mx-auto max-w-3xl px-6 py-10 text-[16px]">
          <p className="text-lg leading-relaxed">{post.intro}</p>

          <aside className="afr-card mt-8 rounded-xl border border-border bg-surface p-5" aria-label="Key takeaways">
            <h2 className="font-display text-lg font-semibold">Key takeaways</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed text-content-secondary">
              {post.keyTakeaways.map((item) => (
                <li key={item}><Inline text={item} /></li>
              ))}
            </ul>
          </aside>

          <nav aria-label="In this article" className="mt-8 text-sm">
            <p className="font-semibold">In this article</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {post.sections.map((section) => (
                <li key={section.heading}>
                  <a href={`#${headingId(section.heading)}`} className="text-accent hover:underline">
                    {section.heading.replace(/^\d+\.\s*/, "")}
                  </a>
                </li>
              ))}
              <li><a href="#faq" className="text-accent hover:underline">Frequently asked questions</a></li>
              <li><a href="#sources" className="text-accent hover:underline">Sources</a></li>
            </ol>
          </nav>

          {post.sections.map((section) => (
            <section key={section.heading} id={headingId(section.heading)} className="mt-10 scroll-mt-24">
              <h2 className="font-display text-2xl font-semibold leading-snug">{section.heading}</h2>
              {section.blocks.map((block, index) => (
                <BlockView key={index} block={block} />
              ))}
            </section>
          ))}

          <aside className="afr-weave-dark mt-12 overflow-hidden rounded-xl bg-ink-950 text-white">
            <div className="afr-band" aria-hidden="true" />
            <div className="p-6">
              <h2 className="font-display text-xl font-semibold">Track your fleet with Raut</h2>
              <p className="mt-2 text-white/80">
                We supply GPS tracking devices and tracker SIM cards, with live fleet tracking in the same system that runs your sales and stock.
              </p>
              <div className="mt-4 flex flex-wrap gap-3 text-sm font-medium">
                <Link href="/gps-trackers" className="rounded-lg bg-accent px-4 py-2 text-white hover:bg-accent-hover">
                  See GPS trackers and SIMs
                </Link>
                <a href={quoteMailto()} className="rounded-lg border border-white/30 px-4 py-2 text-white hover:bg-white/10">
                  Request a quote
                </a>
                {whatsapp ? (
                  <a href={whatsapp} rel="noopener" className="rounded-lg border border-white/30 px-4 py-2 text-white hover:bg-white/10">
                    WhatsApp us
                  </a>
                ) : null}
              </div>
            </div>
          </aside>

          <section id="faq" className="mt-12 scroll-mt-24">
            <h2 className="font-display text-2xl font-semibold">Frequently asked questions</h2>
            <div className="mt-4 space-y-3">
              {post.faq.map((item) => (
                <details key={item.q} className="rounded-lg border border-border bg-surface p-4" open>
                  <summary className="cursor-pointer font-semibold">{item.q}</summary>
                  <p className="mt-2 leading-relaxed text-content-secondary">{item.a}</p>
                </details>
              ))}
            </div>
          </section>

          <section id="sources" className="mt-12 scroll-mt-24">
            <h2 className="font-display text-2xl font-semibold">Sources</h2>
            <p className="mt-2 text-sm text-content-muted">
              Checked on {dateLabel(post.updatedAt)}. Rules and prices change, so confirm anything important with the source.
            </p>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm">
              {post.sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} rel="noopener" className="text-accent underline underline-offset-2">
                    {source.label}
                  </a>
                  {source.date ? <span className="text-content-muted"> ({source.date})</span> : null}
                </li>
              ))}
            </ol>
          </section>

          <section className="mt-12 border-t border-border pt-8">
            <h2 className="font-display text-xl font-semibold">Keep reading</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-3">
              {related.map((item) => (
                <li key={item.slug} className="afr-card rounded-lg border border-border bg-surface p-4">
                  <Link href={`/blog/${item.slug}`} className="text-sm font-semibold hover:text-accent">
                    {item.headline}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </article>
    </PublicChrome>
  );
}
