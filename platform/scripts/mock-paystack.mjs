/**
 * A stand-in for the Paystack API, for tests.
 *
 *   node scripts/mock-paystack.mjs           # listens on MOCK_PAYSTACK_PORT (4720)
 *   import { startMock } from "./mock-paystack.mjs"
 *
 * Emulates POST /transaction/initialize and GET /transaction/verify/:reference,
 * keeps every transaction it has created, and plays the *checkout* too: the
 * control endpoint "pays" a reference, which flips its status and posts a
 * correctly signed `charge.success` (or `charge.failed`) webhook to the URL
 * the test registered — exactly what Paystack's servers do after the payer's
 * browser finishes. The verify body carries a full `authorization` and
 * `customer` object so the platform's payload stripping can be checked.
 *
 * Auth: every API call must carry `Authorization: Bearer <secretKey>` when a
 * secret has been set via control; anything else is a 401 in Paystack's shape.
 *
 * Control:
 *   POST /__control { reset, secretKey, webhookUrl, mode,
 *                     pay: { reference, outcome: "success"|"failed"|"abandoned", amount?, currency?, webhook?: boolean },
 *                     reverse: { reference },
 *                     webhook: { reference, event?, signature?: "good"|"bad"|"missing", amount?, currency? },
 *                     clearRequests }
 *   GET  /__control → { state, requests, transactions, webhooks }
 *
 * Modes (initialize only): ok | timeout | error500
 */

import crypto from "node:crypto";
import http from "node:http";

const DEFAULT_PORT = Number(process.env.MOCK_PAYSTACK_PORT ?? 4720);

export function startMock({ port = DEFAULT_PORT, log = false } = {}) {
  const state = freshState();
  const hung = new Set();
  let seq = 1000;

  const txObject = (tx) => ({
    id: tx.id,
    domain: "test",
    status: tx.status,
    reference: tx.reference,
    amount: tx.amount,
    message: null,
    gateway_response: tx.status === "success" ? "Successful" : tx.status === "failed" ? "Declined" : tx.status === "reversed" ? "Reversed" : "The transaction was not completed",
    paid_at: tx.paidAt,
    created_at: tx.createdAt,
    channel: "card",
    currency: tx.currency,
    ip_address: "127.0.0.1",
    metadata: tx.metadata,
    fees: tx.status === "success" ? Math.round(tx.amount * 0.015) : null,
    customer: { id: 1, email: tx.email, customer_code: "CUS_mock" },
    authorization: {
      authorization_code: "AUTH_mock",
      bin: "408408",
      last4: "4081",
      exp_month: "12",
      exp_year: "2030",
      card_type: "visa",
      bank: "TEST BANK",
      reusable: true,
      signature: "SIG_mock",
    },
    plan: null,
  });

  const postWebhook = async (event, data, { signature = "good" } = {}) => {
    if (!state.webhookUrl) return null;
    const body = JSON.stringify({ event, data });
    const headers = { "content-type": "application/json" };
    if (signature !== "missing") {
      const key = signature === "bad" ? "sk_test_wrong" : state.secretKey ?? "";
      headers["x-paystack-signature"] = crypto.createHmac("sha512", key).update(body).digest("hex");
    }
    const entry = { event, reference: data.reference, signature, status: null, at: new Date().toISOString() };
    state.webhooks.push(entry);
    try {
      const res = await fetch(state.webhookUrl, { method: "POST", headers, body });
      entry.status = res.status;
    } catch (error) {
      entry.status = `error: ${error.message}`;
    }
    if (log) console.log(`[mock-paystack] webhook ${event} ${data.reference} (${signature}) → ${entry.status}`);
    return entry.status;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const path = url.pathname;
    const body = await readJson(req);
    const method = req.method;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));

    const entry = { method, path: path + url.search, headers: { authorization: headers.authorization }, body, status: null, at: new Date().toISOString() };
    const send = (status, payload, contentType = "application/json") => {
      entry.status = status;
      if (!path.startsWith("/__control")) state.requests.push(entry);
      if (log) console.log(`[mock-paystack] ${method} ${path} → ${status}`);
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    // ── control ────────────────────────────────────────────────────────
    if (path === "/__control") {
      if (method === "GET") return send(200, { state: publicState(state), requests: state.requests, transactions: [...state.transactions.values()], webhooks: state.webhooks });
      if (method === "POST") {
        const b = body ?? {};
        if (b.reset) Object.assign(state, freshState());
        if (b.secretKey !== undefined) state.secretKey = b.secretKey;
        if (b.webhookUrl !== undefined) state.webhookUrl = b.webhookUrl;
        if (b.mode) state.mode = b.mode;
        if (b.clearRequests) { state.requests = []; state.webhooks = []; }
        let last = null;
        if (b.pay?.reference) {
          const tx = state.transactions.get(b.pay.reference);
          if (!tx) return send(404, { status: false, message: "Unknown reference" });
          tx.status = b.pay.outcome ?? "success";
          if (b.pay.amount != null) tx.amount = Number(b.pay.amount);
          if (b.pay.currency) tx.currency = b.pay.currency;
          if (tx.status === "success") tx.paidAt = new Date().toISOString();
          if (b.pay.webhook !== false) {
            last = await postWebhook(tx.status === "success" ? "charge.success" : "charge.failed", txObject(tx));
          }
        }
        if (b.reverse?.reference) {
          const tx = state.transactions.get(b.reverse.reference);
          if (!tx) return send(404, { status: false, message: "Unknown reference" });
          tx.status = "reversed";
          if (b.reverse.webhook !== false) {
            last = await postWebhook("refund.processed", {
              status: "processed",
              transaction_reference: tx.reference,
              refund_reference: `RF_${seq++}`,
              amount: tx.amount,
              currency: tx.currency,
              customer: { email: tx.email },
            });
          }
        }
        if (b.webhook?.reference) {
          const tx = state.transactions.get(b.webhook.reference);
          const data = tx ? txObject(tx) : { reference: b.webhook.reference, status: "success", amount: 0, currency: "KES" };
          if (b.webhook.amount != null) data.amount = Number(b.webhook.amount);
          if (b.webhook.currency) data.currency = b.webhook.currency;
          if (b.webhook.status) data.status = b.webhook.status;
          last = await postWebhook(b.webhook.event ?? "charge.success", data, { signature: b.webhook.signature ?? "good" });
        }
        return send(200, { ...publicState(state), lastWebhookStatus: last });
      }
      return send(405, { status: false, message: "Method not allowed" });
    }

    // Hosted checkout page: only so the authorization_url resolves to something.
    const checkout = path.match(/^\/checkout\/([^/]+)$/);
    if (method === "GET" && checkout) {
      const tx = [...state.transactions.values()].find((t) => t.accessCode === checkout[1]);
      if (!tx) return send(404, "<h1>Unknown checkout</h1>", "text/html");
      return send(200, `<h1>Mock Paystack checkout</h1><p>${tx.reference} · ${tx.currency} ${(tx.amount / 100).toFixed(2)}</p>`, "text/html");
    }

    // ── auth ───────────────────────────────────────────────────────────
    const bearer = (headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!bearer || (state.secretKey && bearer !== state.secretKey)) {
      return send(401, { status: false, message: "Invalid key" });
    }

    if (method === "POST" && path === "/transaction/initialize") {
      if (state.mode === "error500") return send(500, { status: false, message: "Internal Server Error" });
      if (state.mode === "timeout") {
        entry.status = "hung";
        state.requests.push(entry);
        hung.add(res);
        return;
      }
      if (!body?.email || !/^\S+@\S+$/.test(String(body.email))) return send(400, { status: false, message: "Invalid email address passed", meta: { nextStep: "Ensure that the email address passed is valid" } });
      if (!Number.isInteger(Number(body.amount)) || Number(body.amount) <= 0) return send(400, { status: false, message: "Invalid amount passed" });
      const reference = body.reference ?? `T${seq++}`;
      if (state.transactions.has(reference)) return send(400, { status: false, message: "Duplicate Transaction Reference" });
      const tx = {
        id: seq++,
        reference,
        amount: Number(body.amount),
        currency: body.currency ?? "NGN",
        email: body.email,
        status: "abandoned",
        accessCode: `ac_${crypto.randomBytes(6).toString("hex")}`,
        callbackUrl: body.callback_url ?? null,
        metadata: body.metadata ?? null,
        paidAt: null,
        createdAt: new Date().toISOString(),
      };
      state.transactions.set(reference, tx);
      return send(200, {
        status: true,
        message: "Authorization URL created",
        data: { authorization_url: `http://127.0.0.1:${port}/checkout/${tx.accessCode}`, access_code: tx.accessCode, reference },
      });
    }

    const verify = path.match(/^\/transaction\/verify\/([^/]+)$/);
    if (method === "GET" && verify) {
      const tx = state.transactions.get(decodeURIComponent(verify[1]));
      if (!tx) return send(404, { status: false, message: "Transaction reference not found" });
      return send(200, { status: true, message: "Verification successful", data: txObject(tx) });
    }

    return send(404, { status: false, message: `No route for ${method} ${path}` });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
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
    secretKey: null,
    webhookUrl: null,
    transactions: new Map(),
    requests: [],
    webhooks: [],
  };
}

function publicState(s) {
  return {
    mode: s.mode,
    secretKey: s.secretKey ? `${s.secretKey.slice(0, 8)}…` : null,
    webhookUrl: s.webhookUrl,
    transactions: s.transactions.size,
    requests: s.requests.length,
    webhooks: s.webhooks.length,
  };
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
  startMock({ log: true }).then(({ url }) => console.log(`mock Paystack listening on ${url} (control: ${url}/__control)`));
}
