import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLUSTERS, POSTS, postBySlug, readingMinutes, type Block } from "./posts";

const allText = (blocks: Block[]) =>
  blocks.flatMap((b) => {
    switch (b.type) {
      case "p":
      case "note":
        return [b.text];
      case "table":
        return [...b.headers, ...b.rows.flat()];
      default:
        return b.items;
    }
  });

const bodyOf = (post: (typeof POSTS)[number]) => post.sections.flatMap((s) => allText(s.blocks)).join("\n");

describe("the blog's SEO rules", () => {
  it("has unique slugs in a clean format", () => {
    const slugs = POSTS.map((p) => p.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    for (const slug of slugs) assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, slug);
  });

  for (const post of POSTS) {
    describe(post.slug, () => {
      it("has a title search engines will not cut off", () => {
        assert.ok(post.title.length <= 60, `${post.title.length}: ${post.title}`);
        assert.ok(post.title.length >= 30, post.title);
      });

      it("has a description of 120 to 160 characters", () => {
        assert.ok(post.description.length >= 120 && post.description.length <= 160, `${post.description.length}: ${post.description}`);
      });

      it("has a unique title and description", () => {
        assert.equal(POSTS.filter((p) => p.title === post.title).length, 1);
        assert.equal(POSTS.filter((p) => p.description === post.description).length, 1);
      });

      it("puts its main topic in the title, headline or description", () => {
        const words = post.primaryKeyword.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const haystack = `${post.title} ${post.headline} ${post.description} ${post.intro}`.toLowerCase();
        const present = words.filter((w) => haystack.includes(w));
        assert.ok(present.length / words.length >= 0.6, `${post.primaryKeyword}: found ${present.join(", ")}`);
      });

      it("links to the product page and another article", () => {
        const body = bodyOf(post);
        assert.ok(body.includes("(/gps-trackers)"), "no link to /gps-trackers");
        assert.ok(/\(\/blog\/[a-z0-9-]+\)/.test(body), "no link to another article");
      });

      it("only links to articles that exist", () => {
        for (const match of bodyOf(post).matchAll(/\(\/blog\/([a-z0-9-]+)\)/g)) {
          assert.ok(postBySlug(match[1]), `dead link: ${match[1]}`);
        }
      });

      it("lists related articles that exist and are not itself", () => {
        assert.ok(post.related.length >= 2);
        for (const slug of post.related) {
          assert.ok(postBySlug(slug), `unknown related: ${slug}`);
          assert.notEqual(slug, post.slug);
        }
      });

      it("backs its claims with sources", () => {
        assert.ok(post.sources.length >= 3, String(post.sources.length));
        for (const source of post.sources) assert.match(source.url, /^https:\/\//);
      });

      it("has a real FAQ and takeaways", () => {
        assert.ok(post.faq.length >= 3);
        assert.ok(post.keyTakeaways.length >= 3);
        for (const item of post.faq) assert.ok(item.q.endsWith("?"), item.q);
      });

      it("has enough depth to be worth ranking", () => {
        const words = bodyOf(post).split(/\s+/).length;
        assert.ok(words >= 300, `${words} words`);
        assert.ok(post.sections.length >= 3);
        assert.ok(readingMinutes(post) >= 2);
      });

      it("belongs to a known cluster and has valid dates", () => {
        assert.ok(post.cluster in CLUSTERS);
        assert.match(post.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(post.updatedAt >= post.publishedAt);
      });

      it("makes no promise it cannot keep", () => {
        const text = `${post.title} ${post.description} ${post.intro} ${bodyOf(post)}`.toLowerCase();
        for (const claim of ["guaranteed", "100% ", "number one", "#1 ", "best in kenya", "cheapest"]) {
          assert.ok(!text.includes(claim), `contains "${claim}"`);
        }
      });
    });
  }

  it("covers every topic cluster", () => {
    for (const cluster of Object.keys(CLUSTERS)) {
      assert.ok(POSTS.some((p) => p.cluster === cluster), cluster);
    }
  });
});
