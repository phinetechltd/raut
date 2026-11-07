import type { MetadataRoute } from "next";

import { POSTS } from "@/content/blog/posts";
import { absoluteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const latest = POSTS.reduce((max, post) => (post.updatedAt > max ? post.updatedAt : max), "2026-11-06");
  return [
    { url: absoluteUrl("/"), lastModified: latest, changeFrequency: "monthly", priority: 1 },
    { url: absoluteUrl("/gps-trackers"), lastModified: latest, changeFrequency: "monthly", priority: 0.9 },
    { url: absoluteUrl("/blog"), lastModified: latest, changeFrequency: "weekly", priority: 0.8 },
    ...POSTS.map((post) => ({
      url: absoluteUrl(`/blog/${post.slug}`),
      lastModified: post.updatedAt,
      changeFrequency: "monthly" as const,
      priority: 0.7,
      images: [absoluteUrl(`/blog/${post.slug}/opengraph-image`)],
    })),
    { url: absoluteUrl("/contact-us"), changeFrequency: "yearly", priority: 0.3 },
    { url: absoluteUrl("/policy"), changeFrequency: "yearly", priority: 0.2 },
  ];
}
