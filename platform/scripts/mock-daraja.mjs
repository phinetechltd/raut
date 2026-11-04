/**
 * A stand-in for Safaricom's Daraja STK API, for tests.
 *
 *   node scripts/mock-daraja.mjs            # listens on MOCK_DARAJA_PORT (4710)
 *   import { startMock } from "./mock-daraja.mjs"
 *
 * Emulates the three endpoints Raut uses — GET /oauth/v1/generate,
 * POST /mpesa/stkpush/v1/processrequest, POST /mpesa/stkpushquery/v1/query —
 * and *sends the callback* to the CallBackURL each push named, the way the real
 * thing does, so the platform's callback route is exercised end to end.
 *
 * Every push is given an outcome from the mode in force when it arrived:
 *
 *   succeed        query → ResultCode 0; success callback with receipt + metadata
 *   cancel         1032 "Request cancelled by user"
 *   timeout        1037 "DS timeout" (no response from the handset)
 *   insufficient   1 "insufficient balance"
 *   pending        query answers HTTP 500 errorCode 500.001.1001 for ever; no
 *                  callback until the control endpoint `complete`s it
 *   pending4999    query answers ResultCode 4999; otherwise as pending
 *   late-success   query and callback say 1037; `complete` later flips it to
 *                  success and sends a success callback
 *   callback-only  query stays 500.001.1001 until the success callback has
 *                  been sent, then answers 0
 *   duplicate      success; the callback is sent three times, with a stale
 *                  1037 callback squeezed in between
 *   mismatch       success, but the callback's Amount is one shilling more
 *   dropped        the push is recorded and acted on, then the socket is
 *                  destroyed before any response (the platform never learns
 *                  the CheckoutRequestID)
 *   hang           the push is recorded and acted on, the response never comes
 *
 * Control:
 *   POST /__control { mode, reset, consumerKey, consumerSecret, invalidateTokens,
 *                     autoCallback, callbackDelayMs, complete: { checkoutRequestId, result },
 *                     clearRequests }
 *   GET  /__control → { state, requests, pushes, callbacks }
 */

import http from "node:http";

const DEFAULT_PORT = Number(process.env.MOCK_DARAJA_PORT ?? 4710);

const RESULT_DESC = {
  0: "The service request is processed successfully.",
  1: "The balance is insufficient for the transaction.",
  1032: "Request cancelled by user",
  1037: "DS timeout user cannot be reached",
  2001: "The initiator information is invalid.",
};

export function startMock({ port = DEFAULT_PORT, log = false } = {}) {
  const state = freshState();
  const hung = new Set();
  let seq = 0;

  const sendCallback = async (push, resultCode, { amountOverride } = {}) => {
    if (!push.callbackUrl) return;
    const code = Number(resultCode);
    const body = {
      Body: {
        stkCallback: {
          MerchantRequestID: push.merchantRequestId,
          CheckoutRequestID: push.checkoutRequestId,
          ResultCode: code,
          ResultDesc: RESULT_DESC[code] ?? `Result ${code}`,
          ...(code === 0
            ? {
                CallbackMetadata: {
                  Item: [
                    { Name: "Amount", Value: amountOverride ?? push.amount },
                    { Name: "MpesaReceiptNumber", Value: push.receipt },
                    { Name: "TransactionDate", Value: Number(push.transactionDate) },
                    { Name: "PhoneNumber", Value: Number(push.phone) },
                  ],
                },
              }
            : {}),
        },
      },
    };
    const entry = { checkoutRequestId: push.checkoutRequestId, resultCode: code, url: push.callbackUrl, status: null, at: new Date().toISOString() };
    state.callbacks.push(entry);
    try {
      const res = await fetch(push.callbackUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      entry.status = res.status;
    } catch (error) {
      entry.status = `error: ${error.message}`;
    }
    if (log) console.log(`[mock-daraja] callback ${push.checkoutRequestId} result=${code} → ${entry.status}`);
  };

  const schedule = (push) => {
    const delay = state.callbackDelayMs;
    const later = (fn, extra = 0) => setTimeout(fn, delay + extra);
    switch (push.outcome) {
      case "succeed":
      case "dropped":
      case "hang":
        if (state.autoCallback) later(() => sendCallback(push, 0));
        break;
      case "cancel":
        if (state.autoCallback) later(() => sendCallback(push, 1032));
        break;
      case "timeout":
      case "late-success":
        if (state.autoCallback) later(() => sendCallback(push, 1037));
        break;
      case "insufficient":
        if (state.autoCallback) later(() => sendCallback(push, 1));
        break;
      case "callback-only":
        if (state.autoCallback) {
          later(async () => {
            await sendCallback(push, 0);
            push.callbackSent = true;
          });
        }
        break;
      case "duplicate":
        if (state.autoCallback) {
          later(() => sendCallback(push, 0));
          later(() => sendCallback(push, 1037), 150);
          later(() => sendCallback(push, 0), 300);
        }
        break;
      case "mismatch":
        if (state.autoCallback) later(() => sendCallback(push, 0, { amountOverride: push.amount + 1 }));
        break;
      default:
        break; // pending / pending4999: nothing until completed
    }
  };

  /** What the STK query answers for a push right now. */
  const queryAnswer = (push) => {
    const ok = (ResultCode) => [200, {
      ResponseCode: "0",
      ResponseDescription: "The service request has been accepted successsfully",
      MerchantRequestID: push.merchantRequestId,
      CheckoutRequestID: push.checkoutRequestId,
      ResultCode: String(ResultCode),
      ResultDesc: RESULT_DESC[ResultCode] ?? `Result ${ResultCode}`,
    }];
    const processing = () => [500, { requestId: `req-${seq++}`, errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }];
    if (push.completed != null) return ok(push.completed);
    switch (push.outcome) {
      case "succeed": case "dropped": case "hang": case "duplicate": case "mismatch":
        return ok(0);
      case "cancel": return ok(1032);
      case "timeout": case "late-success": return ok(1037);
      case "insufficient": return ok(1);
      case "pending4999": return ok(4999);
      case "callback-only": return push.callbackSent ? ok(0) : processing();
      default: return processing();
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const path = url.pathname;
    const body = await readJson(req);
    const method = req.method;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));

    const entry = { method, path: path + url.search, headers: { authorization: headers.authorization }, body, status: null, at: new Date().toISOString() };
    const send = (status, payload) => {
      entry.status = status;
      if (!path.startsWith("/__control")) state.requests.push(entry);
      if (log) console.log(`[mock-daraja] ${method} ${path} → ${status}`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    // ── control ────────────────────────────────────────────────────────
    if (path === "/__control") {
      if (method === "GET") return send(200, { state: publicState(state), requests: state.requests, pushes: [...state.pushes.values()], callbacks: state.callbacks });
      if (method === "POST") {
        const b = body ?? {};
        if (b.reset) Object.assign(state, freshState());
        if (b.mode) state.mode = b.mode;
        if (b.consumerKey !== undefined) state.consumerKey = b.consumerKey;
        if (b.consumerSecret !== undefined) state.consumerSecret = b.consumerSecret;
        if (typeof b.autoCallback === "boolean") state.autoCallback = b.autoCallback;
        if (typeof b.callbackDelayMs === "number") state.callbackDelayMs = b.callbackDelayMs;
        if (b.invalidateTokens) {
          for (const t of state.tokens.keys()) state.invalidTokens.add(t);
          state.tokens.clear();
        }
        if (b.clearRequests) { state.requests = []; state.callbacks = []; }
        if (b.complete?.checkoutRequestId) {
          const push = state.pushes.get(b.complete.checkoutRequestId);
          if (push) {
            push.completed = Number(b.complete.result ?? 0);
            if (b.complete.callback !== false) await sendCallback(push, push.completed);
          }
        }
        if (b.sendCallback?.checkoutRequestId) {
          const push = state.pushes.get(b.sendCallback.checkoutRequestId);
          if (push) await sendCallback(push, b.sendCallback.result ?? 0, { amountOverride: b.sendCallback.amount });
        }
        return send(200, publicState(state));
      }
      return send(405, { errorMessage: "Method not allowed" });
    }

    // ── oauth ──────────────────────────────────────────────────────────
    if (method === "GET" && path === "/oauth/v1/generate") {
      const basic = (headers.authorization ?? "").replace(/^Basic\s+/i, "");
      const [key, secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
      if (state.consumerKey && (key !== state.consumerKey || secret !== state.consumerSecret)) {
        return send(400, { requestId: `req-${seq++}`, errorCode: "400.008.01", errorMessage: "Invalid Authentication passed" });
      }
      const token = `tok-${Date.now().toString(36)}-${seq++}`;
      state.tokens.set(token, Date.now() + 3599_000);
      return send(200, { access_token: token, expires_in: "3599" });
    }

    // ── bearer ─────────────────────────────────────────────────────────
    const bearer = (headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!bearer || state.invalidTokens.has(bearer) || !state.tokens.has(bearer)) {
      return send(404, { requestId: `req-${seq++}`, errorCode: "404.001.03", errorMessage: "Invalid Access Token" });
    }

    if (method === "POST" && path === "/mpesa/stkpush/v1/processrequest") {
      const bad = validatePush(body);
      if (bad) return send(400, { requestId: `req-${seq++}`, errorCode: "400.002.02", errorMessage: `Bad Request - ${bad}` });
      if (state.mode === "error500") return send(500, { requestId: `req-${seq++}`, errorCode: "500.003.1001", errorMessage: "Internal Server Error" });

      const n = ++seq;
      const push = {
        checkoutRequestId: `ws_CO_${Date.now()}${String(n).padStart(4, "0")}`,
        merchantRequestId: `${n}-${Date.now()}-1`,
        amount: Number(body.Amount),
        phone: String(body.PhoneNumber),
        accountReference: body.AccountReference,
        transactionDesc: body.TransactionDesc,
        callbackUrl: body.CallBackURL,
        receipt: `R${Date.now().toString(36).toUpperCase().slice(-5)}${String(n).padStart(4, "0")}`.slice(0, 10),
        transactionDate: timestampNow(),
        outcome: state.mode,
        completed: null,
        callbackSent: false,
        at: new Date().toISOString(),
      };
      state.pushes.set(push.checkoutRequestId, push);
      schedule(push);

      if (push.outcome === "dropped") {
        entry.status = "dropped";
        state.requests.push(entry);
        res.destroy();
        return;
      }
      if (push.outcome === "hang") {
        entry.status = "hung";
        state.requests.push(entry);
        hung.add(res);
        return;
      }
      return send(200, {
        MerchantRequestID: push.merchantRequestId,
        CheckoutRequestID: push.checkoutRequestId,
        ResponseCode: "0",
        ResponseDescription: "Success. Request accepted for processing",
        CustomerMessage: "Success. Request accepted for processing",
      });
    }

    if (method === "POST" && path === "/mpesa/stkpushquery/v1/query") {
      if (!body?.BusinessShortCode || !body?.Password || !/^\d{14}$/.test(String(body?.Timestamp ?? ""))) {
        return send(400, { requestId: `req-${seq++}`, errorCode: "400.002.02", errorMessage: "Bad Request - Invalid Timestamp" });
      }
      const push = state.pushes.get(body.CheckoutRequestID);
      if (!push) return send(400, { requestId: `req-${seq++}`, errorCode: "400.002.02", errorMessage: "Bad Request - Invalid CheckoutRequestID" });
      const [status, payload] = queryAnswer(push);
      return send(status, payload);
    }

    return send(404, { requestId: `req-${seq++}`, errorCode: "404.001.01", errorMessage: `No route for ${method} ${path}` });
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

function validatePush(b) {
  if (!b) return "Invalid Request Payload";
  for (const f of ["BusinessShortCode", "Password", "Timestamp", "TransactionType", "Amount", "PartyA", "PartyB", "PhoneNumber", "CallBackURL", "AccountReference", "TransactionDesc"]) {
    if (b[f] === undefined || b[f] === null || b[f] === "") return `Invalid ${f}`;
  }
  if (!/^\d{14}$/.test(String(b.Timestamp))) return "Invalid Timestamp";
  if (!Number.isInteger(Number(b.Amount)) || Number(b.Amount) < 1) return "Invalid Amount";
  if (!/^2547\d{8}$|^2541\d{8}$/.test(String(b.PhoneNumber))) return "Invalid PhoneNumber";
  if (String(b.AccountReference).length > 12) return "Invalid AccountReference";
  if (String(b.TransactionDesc).length > 13) return "Invalid TransactionDesc";
  try {
    new URL(b.CallBackURL);
  } catch {
    return "Invalid CallBackURL";
  }
  return null;
}

function timestampNow() {
  const d = new Date(Date.now() + 3 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function freshState() {
  return {
    mode: "succeed",
    consumerKey: null,
    consumerSecret: null,
    autoCallback: true,
    callbackDelayMs: 200,
    tokens: new Map(),
    invalidTokens: new Set(),
    pushes: new Map(),
    requests: [],
    callbacks: [],
  };
}

function publicState(s) {
  return {
    mode: s.mode,
    consumerKey: s.consumerKey,
    autoCallback: s.autoCallback,
    callbackDelayMs: s.callbackDelayMs,
    tokens: s.tokens.size,
    pushes: s.pushes.size,
    requests: s.requests.length,
    callbacks: s.callbacks.length,
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
  startMock({ log: true }).then(({ url }) => console.log(`mock Daraja listening on ${url} (control: ${url}/__control)`));
}
