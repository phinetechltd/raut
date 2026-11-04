import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  backoffMs,
  call,
  consoleAdapter,
  digitaxAdapter,
  errorMessage,
  isAlreadySubmitted,
  isRetryable,
  isValidKraPin,
  lineAmounts,
  nairobiDate,
  reconcileUnitPrice,
  saleBody,
  shouldRetry,
  statusFor,
  taxTypeForRate,
  timeoutMs,
  type EtimsCredentials,
} from "./etims";
import { isItemClassCode, isTaxTypeCode } from "./etims-codes";

/**
 * The Digitax HTTP client, with `fetch` stubbed.
 *
 * Nothing here touches the network or the database. What is under test is the
 * part of the integration that decides whether a filing is retried, read back
 * or given up on — the decisions that, wrong, either double-file a sale or
 * drop one.
 */

const CREDS: EtimsCredentials = {
  apiKey: "test-key",
  taxPin: "P051234567X",
  baseUrl: "https://digitax.test/ke/v2/",
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const realFetch = globalThis.fetch;
let seen: Seen[] = [];

/** Installs a fetch that answers with the given status and body. */
function answer(status: number, body: string | object, headers: Record<string, string> = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
}

/** A fetch that never answers until the abort signal fires. */
function hang() {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
}

beforeEach(() => {
  seen = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ETIMS_TIMEOUT_MS;
  delete process.env.ETIMS_BACKOFF_BASE_MS;
});

describe("call()", () => {
  it("sends the API key, JSON headers and an Idempotency-Key on POSTs", async () => {
    answer(200, { id: "sale-1", status: "COMPLETED" });
    const r = await digitaxAdapter.submitSale(CREDS, {
      saleDate: "2026-11-04",
      traderInvoiceNumber: "INV-0001",
      paymentTypeCode: "01",
      invoiceStatusCode: "02",
      items: [],
    });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    const req = seen[0];
    assert.equal(req.method, "POST");
    // No double slash: the base URL's trailing slash is trimmed.
    assert.equal(req.url, "https://digitax.test/ke/v2/sales-with-items");
    assert.equal(req.headers["x-api-key"], "test-key");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["accept"], "application/json");
    assert.equal(req.headers["idempotency-key"], "INV-0001");
    assert.equal((req.body as { trader_invoice_number: string }).trader_invoice_number, "INV-0001");
  });

  it("does not send an Idempotency-Key on a GET", async () => {
    answer(200, { id: "sale-1", status: "COMPLETED" });
    await digitaxAdapter.fetchSale(CREDS, "sale-1");
    assert.equal(seen[0].method, "GET");
    assert.equal(seen[0].url, "https://digitax.test/ke/v2/sales/sale-1");
    assert.equal(seen[0].headers["idempotency-key"], undefined);
    assert.equal(seen[0].body, undefined);
  });

  it("times out after ETIMS_TIMEOUT_MS and the failure is retryable with no status", async () => {
    process.env.ETIMS_TIMEOUT_MS = "20";
    assert.equal(timeoutMs(), 20);
    hang();
    const started = Date.now();
    const r = await call(CREDS, "POST", "/sales-with-items", { a: 1 }, (j) => j);
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, undefined);
    assert.match(r.error ?? "", /Timed out after 20 ms/);
    assert.equal(isRetryable(r.httpStatus), true);
    assert.equal(shouldRetry(r), true);
    assert.ok(Date.now() - started < 2_000, "aborted promptly");
    // The request is still kept for the audit trail.
    assert.deepEqual(r.request, { a: 1 });
  });

  it("falls back to a 20 s timeout when the variable is unset or nonsense", () => {
    delete process.env.ETIMS_TIMEOUT_MS;
    assert.equal(timeoutMs(), 20_000);
    process.env.ETIMS_TIMEOUT_MS = "soon";
    assert.equal(timeoutMs(), 20_000);
    process.env.ETIMS_TIMEOUT_MS = "-5";
    assert.equal(timeoutMs(), 20_000);
  });

  it("treats a 409 as already submitted, never as retryable or rejected", async () => {
    answer(409, { message: "Sale with this trader_invoice_number already exists" });
    const r = await digitaxAdapter.submitSale(CREDS, {
      saleDate: "2026-11-04",
      traderInvoiceNumber: "INV-0001",
      paymentTypeCode: "01",
      invoiceStatusCode: "02",
      items: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 409);
    assert.equal(isAlreadySubmitted(r.httpStatus), true);
    assert.equal(isRetryable(r.httpStatus), false);
    assert.equal(shouldRetry(r), false);
    assert.match(r.error ?? "", /already exists/);
  });

  it("retries 429 and 5xx, not other 4xx", async () => {
    for (const status of [429, 500, 502, 503]) {
      answer(status, { message: `HTTP ${status}` });
      const r = await call(CREDS, "GET", "/etims-info", undefined, (j) => j);
      assert.equal(r.ok, false);
      assert.equal(r.httpStatus, status);
      assert.equal(isRetryable(status), true, `${status} retryable`);
      assert.equal(shouldRetry(r), true, `${status} shouldRetry`);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      answer(status, { message: `HTTP ${status}` });
      const r = await call(CREDS, "GET", "/etims-info", undefined, (j) => j);
      assert.equal(r.ok, false);
      assert.equal(isRetryable(status), false, `${status} not retryable`);
      assert.equal(shouldRetry(r), false, `${status} not shouldRetry`);
    }
  });

  it("treats a non-JSON 2xx as a failure, not an empty sale", async () => {
    answer(200, "<html><body>Maintenance</body></html>", { "content-type": "text/html" });
    const r = await digitaxAdapter.submitSale(CREDS, {
      saleDate: "2026-11-04",
      traderInvoiceNumber: "INV-0002",
      paymentTypeCode: "01",
      invoiceStatusCode: "02",
      items: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.malformed, true);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.data, undefined, "no sale was invented");
    assert.match(r.error ?? "", /non-JSON body/);
    // It may have landed, so it is retried — and the 409 path catches it if so.
    assert.equal(shouldRetry(r), true);
    assert.deepEqual(r.response, { raw: "<html><body>Maintenance</body></html>" });
  });

  it("parses an empty 2xx body as an empty object, which the adapters then reject for want of an id", async () => {
    answer(200, "");
    const r = await call(CREDS, "POST", "/items", {}, (j) => j);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, {});

    answer(200, "");
    const item = await digitaxAdapter.registerItem(CREDS, {
      itemClassCode: "99010000",
      itemTypeCode: "2",
      itemName: "Soda",
      originNationCode: "KE",
      packageUnitCode: "NT",
      quantityUnitCode: "U",
      taxTypeCode: "B",
      defaultUnitPrice: 50,
    });
    assert.equal(item.data?.id, "", "no id was invented");
  });

  it("parses message, detail, error and errors (array and map) into one line", async () => {
    answer(400, {
      message: "Validation failed",
      detail: "See errors",
      errors: [{ field: "items.0.item_class_code", message: "unknown code" }, "quantity must be positive"],
    });
    let r = await call(CREDS, "POST", "/items", {}, (j) => j);
    assert.equal(
      r.error,
      "Validation failed; See errors; items.0.item_class_code: unknown code; quantity must be positive",
    );

    answer(422, { errors: { customer_tin: ["is not a valid PIN"], sale_date: ["is in the future"] } });
    r = await call(CREDS, "POST", "/items", {}, (j) => j);
    assert.equal(r.error, "customer_tin: is not a valid PIN; sale_date: is in the future");

    answer(500, { error: { message: "upstream unavailable" } });
    r = await call(CREDS, "POST", "/items", {}, (j) => j);
    assert.equal(r.error, "upstream unavailable");

    answer(502, "Bad gateway", { "content-type": "text/plain" });
    r = await call(CREDS, "POST", "/items", {}, (j) => j);
    assert.equal(r.error, "Bad gateway");

    assert.equal(errorMessage({}, "", 503), "HTTP 503");
  });

  it("keeps request and response verbatim for the audit trail", async () => {
    answer(201, { id: "it-1", etims_item_code: "KE1NTXU0000001", status: "COMPLETE" });
    const r = await digitaxAdapter.registerItem(CREDS, {
      itemClassCode: "99010000",
      itemTypeCode: "2",
      itemName: "Soda",
      originNationCode: "KE",
      packageUnitCode: "NT",
      quantityUnitCode: "U",
      taxTypeCode: "B",
      defaultUnitPrice: 50,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { id: "it-1", etimsItemCode: "KE1NTXU0000001", status: "COMPLETE" });
    assert.deepEqual(r.response, { id: "it-1", etims_item_code: "KE1NTXU0000001", status: "COMPLETE" });
    assert.equal((r.request as Record<string, unknown>).item_class_code, "99010000");
  });

  it("looks a sale up by trader number and treats 404 as 'not there'", async () => {
    answer(200, { data: [{ id: "sale-9", trader_invoice_number: "INV-0009", status: "COMPLETED", receipt_signature: "ABC" }] });
    let r = await digitaxAdapter.findSaleByTraderNumber(CREDS, "INV-0009");
    assert.equal(r.ok, true);
    assert.equal(r.data?.id, "sale-9");
    assert.equal(r.data?.controlCode, "ABC");
    assert.match(seen[0].url, /\/sales\?trader_invoice_number=INV-0009$/);

    // A loose match is not our sale.
    answer(200, [{ id: "sale-10", trader_invoice_number: "INV-00090", status: "COMPLETED" }]);
    r = await digitaxAdapter.findSaleByTraderNumber(CREDS, "INV-0009");
    assert.equal(r.ok, true);
    assert.equal(r.data, null);

    answer(404, { message: "Not found" });
    r = await digitaxAdapter.findSaleByTraderNumber(CREDS, "INV-0009");
    assert.equal(r.ok, true);
    assert.equal(r.data, null);

    answer(500, { message: "boom" });
    r = await digitaxAdapter.findSaleByTraderNumber(CREDS, "INV-0009");
    assert.equal(r.ok, false);
  });
});

describe("backoff schedule", () => {
  it("doubles from 30 s and caps at an hour", () => {
    assert.equal(backoffMs(1), 30_000);
    assert.equal(backoffMs(2), 60_000);
    assert.equal(backoffMs(3), 120_000);
    assert.equal(backoffMs(7), 30_000 * 64);
    assert.equal(backoffMs(8), 60 * 60_000);
    assert.equal(backoffMs(20), 60 * 60_000);
    assert.equal(backoffMs(0), 30_000, "a nonsense attempt number is treated as the first");
  });

  it("can be collapsed to zero for a test harness", () => {
    process.env.ETIMS_BACKOFF_BASE_MS = "0";
    assert.equal(backoffMs(1), 0);
    assert.equal(backoffMs(5), 0);
    process.env.ETIMS_BACKOFF_BASE_MS = "10";
    assert.equal(backoffMs(3), 40);
  });
});

describe("statusFor", () => {
  it("maps Digitax statuses onto ours", () => {
    assert.equal(statusFor("COMPLETED"), "ACCEPTED");
    assert.equal(statusFor("COMPLETE"), "ACCEPTED");
    assert.equal(statusFor("completed"), "ACCEPTED");
    assert.equal(statusFor("FAILED"), "REJECTED");
    assert.equal(statusFor("SUBMITTED"), "SUBMITTED");
    assert.equal(statusFor("PENDING"), "QUEUED");
    assert.equal(statusFor("PROCESSING"), "QUEUED");
    assert.equal(statusFor(undefined), "QUEUED");
    assert.equal(statusFor(""), "QUEUED");
  });
});

describe("KRA PIN validation", () => {
  it("accepts A and P PINs of the published shape", () => {
    assert.equal(isValidKraPin("P051234567X"), true);
    assert.equal(isValidKraPin("A000111222B"), true);
    assert.equal(isValidKraPin(" P051234567X "), true, "surrounding whitespace is tolerated");
  });

  it("rejects everything else", () => {
    for (const bad of [
      "P05123456X", // eight digits
      "P0512345678X", // ten digits
      "p051234567X", // lower case
      "P051234567x",
      "B051234567X", // wrong prefix
      "P05123456 X",
      "",
      null,
      undefined,
      123,
      "CONSOLE",
    ]) {
      assert.equal(isValidKraPin(bad), false, `${String(bad)} rejected`);
    }
  });
});

describe("Nairobi date", () => {
  it("files on the East African calendar day, not the UTC one", () => {
    // 22:30 UTC on the 1st is 01:30 on the 2nd in Nairobi.
    assert.equal(nairobiDate(new Date("2026-11-01T22:30:00Z")), "2026-11-02");
    // 20:59 UTC is still the 1st in Nairobi (23:59).
    assert.equal(nairobiDate(new Date("2026-11-01T20:59:59Z")), "2026-11-01");
    assert.equal(nairobiDate(new Date("2026-11-01T21:00:00Z")), "2026-11-02");
    // Noon is noon.
    assert.equal(nairobiDate(new Date("2026-06-15T12:00:00Z")), "2026-06-15");
    // Year boundary.
    assert.equal(nairobiDate(new Date("2025-12-31T21:30:00Z")), "2026-01-01");
  });
});

describe("amount reconciliation", () => {
  it("derives a unit price that multiplies back to the total to the cent", () => {
    for (const [qty, cents] of [
      [1, 25000],
      [3, 100],
      [7, 1000],
      [12, 25000],
      [24, 104400],
      [13, 99999],
      [250, 123456],
      [1000, 3],
    ] as Array<[number, number]>) {
      const { unitPrice, reconciles } = reconcileUnitPrice(qty, cents);
      assert.equal(reconciles, true, `${qty} × ? = ${cents}`);
      assert.equal(Math.round(unitPrice * qty * 100), cents, `${qty} × ${unitPrice} = ${cents}`);
    }
  });

  it("keeps two decimals where two decimals suffice", () => {
    assert.deepEqual(reconcileUnitPrice(2, 500), { unitPrice: 2.5, reconciles: true });
    assert.deepEqual(reconcileUnitPrice(1, 25000), { unitPrice: 250, reconciles: true });
    assert.deepEqual(reconcileUnitPrice(0, 0), { unitPrice: 0, reconciles: true });
    assert.deepEqual(reconcileUnitPrice(0, 100), { unitPrice: 0, reconciles: false });
  });

  it("builds line amounts whose parts add up, as 2-dp numbers", () => {
    const line = lineAmounts(3, 100, 86, 14);
    assert.equal(line.quantity, 3);
    assert.equal(line.totalAmount, 1);
    assert.equal(line.taxableAmount, 0.86);
    assert.equal(line.taxAmount, 0.14);
    assert.equal(Math.round(line.unitPrice * 3 * 100), 100);
    assert.equal(Math.round((line.taxableAmount! + line.taxAmount!) * 100), Math.round(line.totalAmount * 100));
  });

  it("rounds every amount in the wire body to two decimals", () => {
    const body = saleBody({
      saleDate: "2026-11-04",
      traderInvoiceNumber: "INV-1",
      paymentTypeCode: "01",
      invoiceStatusCode: "02",
      items: [
        {
          id: "x",
          itemName: "x",
          itemClassCode: "99010000",
          itemBarCode: "x",
          taxTypeCode: "B",
          quantity: 3,
          unitPrice: 0.3333,
          totalAmount: 0.1 + 0.2, // 0.30000000000000004
          taxableAmount: 0.258620689,
          taxAmount: 0.041379311,
          isStockable: true,
        },
      ],
    });
    const item = (body.items as Array<Record<string, number>>)[0];
    assert.equal(item.total_amount, 0.3);
    assert.equal(item.taxable_amount, 0.26);
    assert.equal(item.tax_amount, 0.04);
    assert.equal(item.unit_price, 0.3333);
    assert.equal(item.discount_amount, undefined, "no discount is sent on top of the discounted price");
  });
});

describe("tax type", () => {
  it("distinguishes zero-rated from exempt through the product override", () => {
    assert.equal(taxTypeForRate(1600), "B");
    assert.equal(taxTypeForRate(800), "E");
    assert.equal(taxTypeForRate(0), "C", "zero with no override is zero-rated");
    assert.equal(taxTypeForRate(0, "A"), "A", "an exempt product says so");
    assert.equal(taxTypeForRate(0, "C"), "C");
    assert.equal(taxTypeForRate(0, "D"), "D");
    assert.equal(taxTypeForRate(1600, "A"), "A", "the override wins over the rate");
    assert.equal(taxTypeForRate(1600, "Z"), "B", "an unknown override is ignored");
    assert.equal(taxTypeForRate(1600, null), "B");
    assert.equal(taxTypeForRate(1600, ""), "B");
  });

  it("validates codes against the tables", () => {
    assert.equal(isTaxTypeCode("A"), true);
    assert.equal(isTaxTypeCode("F"), false);
    assert.equal(isTaxTypeCode("constructor"), false, "prototype keys are not codes");
    assert.equal(isItemClassCode("99010000"), true);
    assert.equal(isItemClassCode("12345678"), true, "any eight-digit code may be stored on a product");
    assert.equal(isItemClassCode("12345678", { tableOnly: true }), false, "defaults come from the table");
    assert.equal(isItemClassCode("1234567"), false);
    assert.equal(isItemClassCode("abcdefgh"), false);
  });
});

describe("console adapter", () => {
  it("never finds a duplicate and gives the same control code for the same reference", async () => {
    const a = await consoleAdapter.submitSale(CREDS, {
      saleDate: "2026-11-04",
      traderInvoiceNumber: "INV-7",
      paymentTypeCode: "01",
      invoiceStatusCode: "02",
      items: [],
    });
    const b = await consoleAdapter.fetchSale(CREDS, "INV-7");
    assert.equal(a.data?.controlCode, b.data?.controlCode);
    assert.equal(a.data?.status, "COMPLETED");
    const none = await consoleAdapter.findSaleByTraderNumber(CREDS, "INV-7");
    assert.equal(none.ok, true);
    assert.equal(none.data, null);
  });
});
