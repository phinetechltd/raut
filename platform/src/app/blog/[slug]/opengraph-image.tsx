import { ImageResponse } from "next/og";

import { CLUSTERS, POSTS, postBySlug } from "@/content/blog/posts";

export const alt = "Raut logistics blog";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export function generateStaticParams() {
  return POSTS.map((post) => ({ slug: post.slug }));
}

const BAND = ["#C8501E", "#E0A030", "#1F7A4D", "#27306B"];

/** The share card for an article: the headline over the Raut bead band. */
export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = postBySlug(slug);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#1A130D", color: "#FAF6EF" }}>
        <div style={{ display: "flex", height: 28 }}>
          {Array.from({ length: 40 }, (_, index) => (
            <div key={index} style={{ width: 30, height: 28, background: BAND[index % BAND.length] }} />
          ))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 72px" }}>
          <div style={{ fontSize: 28, color: "#EBA478", letterSpacing: 2, textTransform: "uppercase" }}>
            {post ? CLUSTERS[post.cluster].label : "Logistics blog"}
          </div>
          <div style={{ fontSize: 62, fontWeight: 700, lineHeight: 1.15, marginTop: 24 }}>
            {post?.headline ?? "Raut logistics blog"}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0 72px 44px", fontSize: 28, color: "#D4C5AE" }}>
          <div>Raut · One Platform. Every Mile.</div>
          <div>raut.co.ke</div>
        </div>
      </div>
    ),
    size,
  );
}
