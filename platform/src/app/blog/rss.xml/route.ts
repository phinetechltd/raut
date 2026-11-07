import { POSTS } from "@/content/blog/posts";
import { absoluteUrl } from "@/lib/seo";

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An RSS feed, so new articles are picked up by readers and aggregators. */
export function GET() {
  const items = [...POSTS]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map((post) => {
      const url = absoluteUrl(`/blog/${post.slug}`);
      return [
        "<item>",
        `<title>${escapeXml(post.headline)}</title>`,
        `<link>${url}</link>`,
        `<guid isPermaLink="true">${url}</guid>`,
        `<pubDate>${new Date(`${post.publishedAt}T12:00:00+03:00`).toUTCString()}</pubDate>`,
        `<description>${escapeXml(post.description)}</description>`,
        "</item>",
      ].join("");
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Raut logistics blog</title><link>${absoluteUrl("/blog")}</link><atom:link href="${absoluteUrl("/blog/rss.xml")}" rel="self" type="application/rss+xml"/><description>GPS tracking, cargo security and fleet costs in Kenya and East Africa.</description><language>en-ke</language>${items}</channel></rss>`;

  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
