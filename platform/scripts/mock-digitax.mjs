/**
 * A stand-in for the Digitax eTIMS API, for tests.
 *
 *   node scripts/mock-digitax.mjs            # listens on MOCK_DIGITAX_PORT (4700)
 *   import { startMock } from "./mock-digitax.mjs"
 *
 * It emulates the handful of endpoints Raut uses — POST /items, /customers,
 * /sales-with-items, /credit-notes, PUT /stock/adjust, GET /sales/{id},
 * GET /sales?trader_invoice_number=, GET /etims-info — and keeps every sale it
 * has accepted, so a duplicate trader invoice number is a 409 exactly as the
 * real API answers. Paths may carry the `/ke/v2` prefix or not.
 *
 * Failure modes are switched through a control endpoint, which is how the
 * smoke test walks the platform through every path a flaky tax API can take:
 *
 *   POST /__control  { mode, lookupSupported, taxPin, apiKey, completePending, reset }
 *   GET  /__control  → { state, requests, sales }
 *
 * Modes (apply to writes; reads keep working so reconciliation can be tested):
 *   ok        everything succeeds, sales COMPLETED
 *   pending   sales/credit notes are accepted as PENDING until completePending
 *   timeout   the sale is recorded, the response never comes
 *   conflict  409 on every sale POST, but the sale is recorded (it "landed")
 *   error500 / error429 / error400 / nonjson
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_PORT = Number(process.env.MOCK_DIGITAX_PORT ?? 4700);

export function startMock({ port = DEFAULT_PORT, log = false } = {}) {
  const state = freshState();
  const hung = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const path = url.pathname.replace(/^\/ke\/v2(?=\/|$)/, "") || "/";
    const body = await readJson(req);
    const method = req.method;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));

    const entry = { method, path: path + url.search, headers, body, status: null, at: new Date().toISOString() };
    const send = (status, payload, contentType = "application/json") => {
      entry.status = status;
      if (!path.startsWith("/__control")) state.requests.push(entry);
      if (log) console.log(`[mock-digitax] ${method} ${path} → ${status}`);
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    // ── control ────────────────────────────────────────────────────────
    if (path === "/__control") {
      if (method === "GET") return send(200, { state: publicState(state), requests: state.requests, sales: [...state.sales.values()] });
      if (method === "POST") {
        const b = body ?? {};
        if (b.reset) Object.assign(state, freshState());
        if (b.mode) state.mode = b.mode;
        if (typeof b.lookupSupported === "boolean") state.lookupSupported = b.lookupSupported;
        if (typeof b.taxPin === "string") state.taxPin = b.taxPin;
        if (b.apiKey !== undefined) state.apiKey = b.apiKey;
        if (b.completePending) {
          for (const s of state.sales.values()) {
            if (s.status === "PENDING") complete(s);
          }
        }
        if (b.clearRequests) state.requests = [];
        return send(200, publicState(state));
      }
      return send(405, { message: "Method not allowed" });
    }

    // ── auth ───────────────────────────────────────────────────────────
    const key = headers["x-api-key"];
    if (!key || (state.apiKey && key !== state.apiKey)) {
      return send(401, { message: "Invalid or missing API key" });
    }

    const write = method === "POST" || method === "PUT";

    // ── failure modes on writes ────────────────────────────────────────
    if (write) {
      switch (state.mode) {
        case "error500":
          return send(500, { message: "Internal Server Error" });
        case "error429":
          return send(429, { message: "Too many requests", detail: "Rate limit exceeded" });
        case "error400":
          return send(400, { errors: [{ field: "items.0.item_class_code", message: "unknown classification" }] });
        case "nonjson":
          return send(200, "<html><body>Maintenance</body></html>", "text/html");
        default:
          break;
      }
    }

    // ── endpoints ──────────────────────────────────────────────────────
    if (method === "GET" && path === "/etims-info") {
      return send(200, {
        tax_pin: state.taxPin,
        branch_office_name: "Mock Head Office",
        branch_id: "00",
        business_id: "mock-business",
        is_head_office: true,
      });
    }

    if (method === "POST" && path === "/items") {
      const errors = [];
      for (const f of ["item_class_code", "item_type_code", "item_name", "tax_type_code", "quantity_unit_code", "package_unit_code", "origin_nation_code"]) {
        if (body?.[f] === undefined || body?.[f] === null || body?.[f] === "") errors.push({ field: f, message: "is required" });
      }
      if (body?.item_class_code && !/^\d{8}$/.test(String(body.item_class_code))) errors.push({ field: "item_class_code", message: "must be eight digits" });
      if (body?.tax_type_code && !/^[A-E]$/.test(String(body.tax_type_code))) errors.push({ field: "tax_type_code", message: "unknown tax type" });
      if (errors.length) return send(400, { message: "Validation failed", errors });
      const id = `itm-${randomUUID().slice(0, 8)}`;
      const item = { id, etims_item_code: `KE1NTXU${String(state.items.size + 1).padStart(7, "0")}`, status: "COMPLETE", ...body };
      state.items.set(id, item);
      state.items.set(item.etims_item_code, item);
      return send(201, { id, etims_item_code: item.etims_item_code, status: "COMPLETE" });
    }

    if (method === "POST" && path === "/customers") {
      if (!body?.customer_tin) return send(400, { message: "customer_tin is required" });
      if (!/^[AP]\d{9}[A-Z]$/.test(String(body.customer_tin))) return send(400, { errors: { customer_tin: ["is not a valid PIN"] } });
      const id = `cus-${randomUUID().slice(0, 8)}`;
      state.customers.set(id, body);
      return send(201, { id });
    }

    if (method === "POST" && path === "/sales-with-items") {
      const trader = body?.trader_invoice_number;
      const errors = validateSale(body, state);
      if (errors.length) return send(400, { message: "Validation failed", errors });
      if (state.byTrader.has(trader)) return send(409, { message: "Sale with this trader_invoice_number already exists" });

      const sale = newSale(state, trader, body, state.mode === "pending" ? "PENDING" : "COMPLETED");
      if (state.mode === "conflict") return send(409, { message: "Sale with this trader_invoice_number already exists" });
      if (state.mode === "timeout") {
        entry.status = "hung";
        state.requests.push(entry);
        hung.add(res);
        return; // never answered
      }
      return send(201, sale);
    }

    if (method === "POST" && path === "/credit-notes") {
      const trader = body?.trader_invoice_number;
      if (!body?.sale_id || !state.sales.has(body.sale_id)) return send(400, { message: "sale_id does not reference a sale" });
      const original = state.sales.get(body.sale_id);
      if (original.status !== "COMPLETED") return send(400, { message: "Original sale is not completed" });
      if (!trader) return send(400, { errors: { trader_invoice_number: ["is required"] } });
      if (!Array.isArray(body.items) || body.items.length === 0) return send(400, { errors: { items: ["must not be empty"] } });
      for (const [i, it] of body.items.entries()) {
        if (Math.abs(round2(Number(it.quantity) * Number(it.unit_price)) - Number(it.total_amount)) > 0.01) {
          return send(400, { errors: [{ field: `items.${i}.total_amount`, message: "does not equal quantity × unit_price" }] });
        }
      }
      if (state.byTrader.has(trader)) return send(409, { message: "Credit note with this trader_invoice_number already exists" });
      const note = newSale(state, trader, body, state.mode === "pending" ? "PENDING" : "COMPLETED");
      note.kind = "CREDIT_NOTE";
      if (state.mode === "conflict") return send(409, { message: "already exists" });
      if (state.mode === "timeout") {
        entry.status = "hung";
        state.requests.push(entry);
        hung.add(res);
        return;
      }
      return send(201, note);
    }

    if (method === "PUT" && path === "/stock/adjust") {
      if (!body?.item_id || !state.items.has(body.item_id)) return send(400, { message: "Unknown item_id" });
      if (!["ADD", "DEDUCT"].includes(body.action)) return send(400, { message: "action must be ADD or DEDUCT" });
      const item = state.items.get(body.item_id);
      item.stock = (item.stock ?? 0) + (body.action === "ADD" ? 1 : -1) * Number(body.quantity ?? 0);
      return send(200, { item_id: body.item_id, stock_quantity: item.stock });
    }

    if (method === "GET" && path === "/sales") {
      if (!state.lookupSupported) return send(404, { message: "Not Found" });
      const trader = url.searchParams.get("trader_invoice_number");
      const id = trader ? state.byTrader.get(trader) : null;
      return send(200, { data: id ? [state.sales.get(id)] : [] });
    }

    const saleMatch = path.match(/^\/sales\/([^/]+)$/);
    if (method === "GET" && saleMatch) {
      const sale = state.sales.get(decodeURIComponent(saleMatch[1]));
      return sale ? send(200, sale) : send(404, { message: "Sale not found" });
    }

    return send(404, { message: `No route for ${method} ${path}` });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        baseUrl: `${url}/ke/v2`,
        state,
        close: () =>
          new Promise((r) => {
            for (const res of hung) res.destroy();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function freshState() {
  return {
    mode: "ok",
    lookupSupported: true,
    taxPin: "P051234567X",
    apiKey: null,
    items: new Map(),
    customers: new Map(),
    sales: new Map(),
    byTrader: new Map(),
    requests: [],
  };
}

function publicState(s) {
  return {
    mode: s.mode,
    lookupSupported: s.lookupSupported,
    taxPin: s.taxPin,
    apiKey: s.apiKey,
    items: s.items.size,
    sales: s.sales.size,
    requests: s.requests.length,
  };
}

function newSale(state, trader, body, status) {
  const id = `sale-${randomUUID().slice(0, 8)}`;
  const sale = {
    id,
    kind: "SALE",
    trader_invoice_number: trader,
    status,
    receipt_signature: null,
    invoice_number: null,
    serial_number: null,
    receipt_number: null,
    etims_url: null,
    offline_url: null,
    sale_date: body.sale_date ?? body.return_date,
    items: body.items,
  };
  if (status === "COMPLETED") complete(sale);
  state.sales.set(id, sale);
  state.byTrader.set(trader, id);
  return sale;
}

function complete(sale) {
  const n = sale.id.slice(-8).toUpperCase();
  sale.status = "COMPLETED";
  sale.receipt_signature = `SIG${n}`;
  sale.invoice_number = Number.parseInt(n.replace(/[^0-9]/g, "").slice(0, 5) || "1", 10);
  sale.serial_number = `KRACU0100000${n.slice(0, 3)}`;
  sale.receipt_number = (sale.invoice_number % 9000) + 1;
  sale.etims_url = `https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceptData?Data=P051234567X0100000${sale.receipt_number}`;
}

function validateSale(body, state) {
  const errors = [];
  if (!body) return [{ field: "body", message: "must be JSON" }];
  for (const f of ["sale_date", "trader_invoice_number", "payment_type_code", "invoice_status_code"]) {
    if (!body[f]) errors.push({ field: f, message: "is required" });
  }
  if (body.sale_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.sale_date))) errors.push({ field: "sale_date", message: "must be YYYY-MM-DD" });
  if (body.customer_tin && !/^[AP]\d{9}[A-Z]$/.test(String(body.customer_tin))) errors.push({ field: "customer_tin", message: "is not a valid PIN" });
  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push({ field: "items", message: "must not be empty" });
    return errors;
  }
  for (const [i, it] of body.items.entries()) {
    if (!it.id || !state.items.has(String(it.id))) errors.push({ field: `items.${i}.id`, message: "is not a registered item" });
    if (!/^\d{8}$/.test(String(it.item_class_code ?? ""))) errors.push({ field: `items.${i}.item_class_code`, message: "must be eight digits" });
    if (!/^[A-E]$/.test(String(it.item_tax_type_code ?? ""))) errors.push({ field: `items.${i}.item_tax_type_code`, message: "unknown tax type" });
    const q = Number(it.quantity);
    const u = Number(it.unit_price);
    const t = Number(it.total_amount);
    if (!(q > 0)) errors.push({ field: `items.${i}.quantity`, message: "must be positive" });
    if (Math.abs(round2(q * u) - t) > 0.01) errors.push({ field: `items.${i}.total_amount`, message: `does not equal quantity × unit_price (${q} × ${u} ≠ ${t})` });
    if (it.taxable_amount !== undefined && it.tax_amount !== undefined && Math.abs(round2(Number(it.taxable_amount) + Number(it.tax_amount)) - t) > 0.01) {
      errors.push({ field: `items.${i}.tax_amount`, message: "taxable_amount + tax_amount does not equal total_amount" });
    }
  }
  return errors;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ __raw: data });
      }
    });
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  startMock({ log: true }).then(({ url }) => console.log(`mock Digitax listening on ${url} (control: ${url}/__control)`));
}
