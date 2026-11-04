import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { preserved, tableHref, tableState, toggleSort } from "./table";

/**
 * Every list page keeps its sort, direction and page in the URL through these
 * helpers, so a mistake here shows up on every table at once.
 */
describe("tableState", () => {
  it("reads prefixed keys and whitelists the sort column", () => {
    const s = tableState(
      { cust_sort: "name", cust_dir: "desc", cust_page: "3", cust_limit: "20" },
      { prefix: "cust", allowed: ["name", "code"] },
    );
    assert.deepEqual(s, { page: 3, limit: 20, sort: "name", dir: "desc" });
    assert.equal(tableState({ cust_sort: "evil" }, { prefix: "cust", allowed: ["name"] }).sort, null);
  });

  it("honours an explicit desc on a table that defaults to asc", () => {
    const s = tableState({ dir: "desc" }, { defaultDir: "asc" });
    assert.equal(s.dir, "desc");
    assert.equal(tableState({}, { defaultDir: "asc" }).dir, "asc");
    assert.equal(tableState({ dir: "sideways" }, { defaultDir: "asc" }).dir, "asc");
  });

  it("clamps page and limit to sane bounds", () => {
    const s = tableState({ page: "-4", limit: "9999" });
    assert.equal(s.page, 1);
    assert.equal(s.limit, 100);
    assert.equal(tableState({ limit: "1" }).limit, 5);
  });
});

describe("toggleSort", () => {
  it("flips direction on the active column and starts ascending elsewhere", () => {
    const current = { page: 1, limit: 15, sort: "name", dir: "asc" as const };
    assert.deepEqual(toggleSort(current, "name"), { sort: "name", dir: "desc" });
    assert.deepEqual(toggleSort(current, "code"), { sort: "code", dir: "asc" });
  });
});

describe("tableHref", () => {
  it("resets the page when the sort changes and drops emptied keys", () => {
    const href = tableHref(
      "/app/customers",
      { cust_page: "4", q: "nai", cust_sort: "name" },
      { cust_sort: "code", cust_dir: "asc", q: null },
      "cust",
    );
    const url = new URL(href, "http://x");
    assert.equal(url.pathname, "/app/customers");
    assert.equal(url.searchParams.get("cust_page"), "1");
    assert.equal(url.searchParams.get("cust_sort"), "code");
    assert.equal(url.searchParams.get("q"), null);
  });

  it("keeps the page when only the page changes", () => {
    const href = tableHref("/app/sales", { inv_sort: "total" }, { inv_page: 2 });
    assert.equal(new URL(href, "http://x").searchParams.get("inv_page"), "2");
  });
});

describe("preserved", () => {
  it("returns every param except the ones a form owns", () => {
    assert.deepEqual(preserved({ a: "1", b: "2", c: undefined }, ["b"]), { a: "1" });
  });
});
