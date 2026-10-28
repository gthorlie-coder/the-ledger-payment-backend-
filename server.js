/**
 * The Ledger — Payment Backend
 * =============================
 * Two ways this confirms a payment, built to work together:
 *
 * 1. SMS-forwarding (works TODAY, no telecom approval needed):
 *    A phone holding the receiving SIM runs a free SMS-forwarder app that
 *    POSTs every incoming SMS to /api/sms-webhook. This server looks for a
 *    reference code (e.g. LEDGER-A1B2C3) in the message text and, if found,
 *    marks that subscription paid.
 *
 * 2. MTN MoMo Open API (activate once your production credentials arrive):
 *    /api/momo/request-to-pay and /api/momo/callback are wired up and ready
 *    — they just need MOMO_* values in your .env to start working. Until
 *    then they respond with a clear "not configured yet" message instead of
 *    silently failing.
 *
 * Storage is a single JSON file (data/subscriptions.json). That's plenty for
 * a small subscriber base — if this grows a lot, swap loadDB/saveDB for a
 * real database without touching the rest of the file.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" })); // live sync sends batches of encrypted entries
app.use(express.text({ type: ["text/plain", "text/*"] })); // some SMS-forwarder apps POST plain text

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "subscriptions.json");
const SUBSCRIPTION_DAYS = 30;

/* ---------------- subscription prices per country ----------------
   The server decides the price — never the app/phone — so nobody can pay
   less by tampering with the request. Change prices here or in .env.
   usd: price when the customer pays in US dollars
   lrd: optional price when paying in Liberian dollars (null = LRD not accepted
        automatically; such payments are held for you to confirm by hand) */
const PRICES = {
  LR: {
    usd: parseFloat(process.env.PRICE_LR_USD || "2.00"),
    lrd: parseFloat(process.env.PRICE_LR_LRD || "400"),
    momoCurrency: process.env.MOMO_CURRENCY_LR || "USD",
  },
  // Guinea and Sierra Leone: fill in once you have payment numbers there.
  GN: { usd: null, lrd: null, momoCurrency: "GNF" },
  SL: { usd: null, lrd: null, momoCurrency: "SLE" },
};
const DEFAULT_COUNTRY = "LR";
function priceFor(country) {
  return PRICES[country] || PRICES[DEFAULT_COUNTRY];
}
/* Returns "ok", "underpaid", or "unknown" (amount/currency not readable). */
function checkAmount(country, amount, currency) {
  const p = priceFor(country);
  if (amount == null || !currency) return "unknown";
  const expected = currency === "LRD" ? p.lrd : p.usd;
  if (expected == null) return "unknown";
  return amount + 0.001 >= expected ? "ok" : "underpaid";
}

/* ---------------- storage that survives restarts ----------------
   Uses Upstash Redis when UPSTASH_REDIS_REST_URL/TOKEN are set (Render wipes
   local files on every restart and deploy). Falls back to local files only
   for testing on a computer. */
const DOC_DIR = path.join(__dirname, "data", "docs");
async function docGet(key) {
  if (USE_REDIS) { const v = await redisCmd(["GET", "ledger-doc:" + key]); return v ? JSON.parse(v) : null; }
  const f = path.join(DOC_DIR, encodeURIComponent(key) + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
async function docPut(key, val) {
  const t = JSON.stringify(val);
  if (USE_REDIS) return redisCmd(["SET", "ledger-doc:" + key, t]);
  fs.mkdirSync(DOC_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOC_DIR, encodeURIComponent(key) + ".json"), t);
}
const subGet = (ref) => docGet("sub:" + ref);
const subPut = (ref, rec) => docPut("sub:" + ref, rec);
// The phone numbers that RECEIVE payments (yours) — never treated as a customer's number.
const RECEIVING_NUMBERS = String(process.env.RECEIVING_NUMBERS || "231771466188").split(/[,\s]+/).map((x) => normPhone(x)).filter(Boolean);
// Liberian numbers: +231 77 146 6188, 0771466188, 771466188 → "771466188"
function normPhone(x) {
  let d = String(x || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length >= 10 && d.startsWith("231")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length >= 7 && d.length <= 10 ? d : null;
}
// Recent payment messages, newest first (shown on /admin).
async function logPayment(ev) {
  try {
    const list = (await docGet("paylog")) || [];
    list.unshift(Object.assign({ at: new Date().toISOString() }, ev));
    await docPut("paylog", list.slice(0, 150));
  } catch (e) { console.error("paylog:", e.message); }
}
// Moves records from the old local files into Redis once (harmless if the files are gone).
async function migrateOldFiles() {
  if (!USE_REDIS) return;
  try {
    const subsFile = path.join(__dirname, "data", "subscriptions.json");
    if (fs.existsSync(subsFile)) {
      const db = JSON.parse(fs.readFileSync(subsFile, "utf8"));
      for (const [ref, rec] of Object.entries(db)) if (!(await subGet(ref))) await subPut(ref, rec);
      fs.renameSync(subsFile, subsFile + ".moved");
    }
    const staffFile = path.join(__dirname, "data", "staff-requests.json");
    if (fs.existsSync(staffFile)) {
      const db = JSON.parse(fs.readFileSync(staffFile, "utf8"));
      for (const [id, shop] of Object.entries(db)) if (!(await docGet("staff:" + id))) await docPut("staff:" + id, shop);
      fs.renameSync(staffFile, staffFile + ".moved");
    }
  } catch (e) { console.error("migrate old files:", e.message); }
}

/* ---------------- helpers ---------------- */
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function requireSecret(expected) {
  return (req, res, next) => {
    const provided = req.get("Authorization")?.replace(/^Bearer\s+/i, "") || req.body?.secret || req.query.secret;
    if (!expected || provided !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
  };
}

/* ---------------- reference code parsing ----------------
   Looks for LEDGER-XXXXXX (6 letters/digits) anywhere in a text blob, plus a
   best-effort amount, so it works across different SMS wordings/networks. */
function parseIncomingSms(text) {
  text = String(text || "");
  const refMatch = /LEDGER-?\s?([A-Z0-9]{6})\b/i.exec(text);
  // "USD 2.00", "L$400", "$2" … or "2.00 USD", "400 LRD", "400.00 L$"
  let m = /(L\$|LRD|USD|US\$|\$)\s?([\d,]+(?:\.\d+)?)/i.exec(text), sym = null, num = null;
  if (m) { sym = m[1]; num = m[2]; }
  else { m = /([\d,]+(?:\.\d+)?)\s?(LRD|USD|L\$|US\$|Liberian dollars?|US dollars?)/i.exec(text); if (m) { num = m[1]; sym = m[2]; } }
  let currency = null;
  if (sym) { const u = sym.toUpperCase(); currency = (u === "L$" || u === "LRD" || u.startsWith("LIBERIAN")) ? "LRD" : "USD"; }
  const phones = [];
  (text.match(/\+?\d[\d\s-]{6,16}\d/g) || []).forEach((x) => { const n = normPhone(x); if (n && !phones.includes(n) && !RECEIVING_NUMBERS.includes(n)) phones.push(n); });
  return {
    ref: refMatch ? refMatch[1].toUpperCase() : null,
    amount: num ? parseFloat(num.replace(/,/g, "")) : null,
    currency,
    phones,
    raw: text,
  };
}
function genRef() {
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

/* ==================================================================
   ROUTES
   ================================================================== */

// Current price — the app can show this so the banner always matches the server.
app.get("/api/price", (req, res) => {
  const country = String(req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const p = priceFor(country);
  res.json({ ok: true, country: PRICES[country] ? country : DEFAULT_COUNTRY, usd: p.usd, lrd: p.lrd, days: SUBSCRIPTION_DAYS });
});

// Health check — visit this URL in a browser to confirm the server is alive.
// Health check in plain words — open /api/health in any browser.
const SERVER_VERSION = "v31";
app.get("/api/health", async (req, res) => {
  const out = { ok: true, version: SERVER_VERSION, time: new Date().toISOString(),
    storage: USE_REDIS ? "Upstash Redis" : "local files only (records are LOST when Render restarts — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)",
    storageWorking: null, storageProblem: null,
    paymentsFromSms: process.env.SMS_WEBHOOK_SECRET ? "ready" : "not ready — add SMS_WEBHOOK_SECRET on Render",
    adminDashboard: ADMIN_KEY ? "ready — open /admin" : "off — add ADMIN_KEY on Render",
    shopsInMemory: syncCache.size };
  try {
    if (USE_REDIS) { await redisCmd(["SET", "ledger-health", out.time]); const v = await redisCmd(["GET", "ledger-health"]); out.storageWorking = v === out.time; }
    else out.storageWorking = true;
  } catch (e) {
    let msg = String(e.message || e);
    if (REDIS_TOKEN) msg = msg.split(REDIS_TOKEN).join("[token hidden]"); // never show the password on a public page
    msg = msg.replace(/Bearer\s+\S+/g, "Bearer [token hidden]");
    if (REDIS_TOKEN_HIDDEN) msg = "The token was copied while Upstash showed ******** — click the eye icon on Upstash first, then copy again.";
    else if (/\b(401|403)\b|unauthori[sz]ed|NOPERM|readonly|read-only/i.test(msg)) msg = "Upstash refused the token. Copy it again from Upstash (make sure \"Read-Only Token\" is OFF). Details: " + msg;
    out.storageWorking = false; out.storageProblem = msg.slice(0, 300); out.ok = false;
  }
  out.summary = out.storageWorking ? "✅ Server and storage are working." : "❌ The server can't save to Upstash: " + out.storageProblem;
  res.json(out);
});
app.get("/", (req, res) => {
  res.json({ ok: true, service: "The Ledger payment backend", time: new Date().toISOString() });
});

/* ---- 1. PWA registers a new install and gets a reference code ---- */
app.post("/api/register", async (req, res) => {
  try {
    const requested = String(req.body?.country || DEFAULT_COUNTRY).toUpperCase();
    const country = PRICES[requested] ? requested : DEFAULT_COUNTRY;
    let ref = genRef();
    while (await subGet(ref)) ref = genRef(); // avoid the rare collision
    await subPut(ref, { createdAt: today(), country, paid: false, paidAt: null, renewedUntil: null, lastAmount: null, lastRawSms: null });
    const p = priceFor(country);
    res.json({ ok: true, ref: `LEDGER-${ref}`, country, priceUsd: p.usd, priceLrd: p.lrd });
  } catch (e) { console.error("register:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ---- 1b. The customer says which number they will pay from ----
   Orange Money's "you received money" SMS shows the sender's number but
   often NOT the note they typed, so the number is how we find their code. */
app.post("/api/payer", async (req, res) => {
  try {
    const code = String(req.body?.ref || "").replace(/^LEDGER-/i, "").toUpperCase();
    const phone = normPhone(req.body?.phone);
    const rec = code ? await subGet(code) : null;
    if (!rec) return res.status(404).json({ ok: false, error: "Unknown reference code" });
    if (!phone || RECEIVING_NUMBERS.includes(phone)) return res.status(400).json({ ok: false, error: "Enter the phone number you will send the money from" });
    if (rec.payerPhone && rec.payerPhone !== phone) {
      const old = (await docGet("subphone:" + rec.payerPhone)) || [];
      await docPut("subphone:" + rec.payerPhone, old.filter((r) => r !== code));
    }
    rec.payerPhone = phone; rec.payerSetAt = new Date().toISOString();
    await subPut(code, rec);
    const list = ((await docGet("subphone:" + phone)) || []).filter((r) => r !== code);
    list.push(code);
    await docPut("subphone:" + phone, list.slice(-5));
    res.json({ ok: true, phone });
  } catch (e) { console.error("payer:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ---- 2. PWA polls this to check if payment has landed ---- */
app.get("/api/status/:ref", async (req, res) => {
  try {
    const code = (req.params.ref || "").replace(/^LEDGER-/i, "").toUpperCase();
    const record = await subGet(code);
    if (!record) return res.status(404).json({ ok: false, error: "Unknown reference code" });
    res.json({
      ok: true,
      paid: !!record.paid,
      renewedUntil: record.renewedUntil,
      active: record.renewedUntil ? record.renewedUntil >= today() : false,
      payerPhone: record.payerPhone || null,
      pendingReview: record.pendingReview ? record.pendingReview.reason : null,
    });
  } catch (e) { console.error("status:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});

// Adds 30 days — from today, or from the current end date if the customer renews early.
function extendSubscription(record) {
  const base = record.renewedUntil && record.renewedUntil > today() ? record.renewedUntil : today();
  record.paid = true;
  record.paidAt = today();
  record.renewedUntil = addDays(base, SUBSCRIPTION_DAYS);
  delete record.pendingReview;
  return record;
}

/* ---- 3. SMS-forwarder app posts every incoming SMS here ----
   Protect this with SMS_WEBHOOK_SECRET so a stranger can't fake payments.
   Accepts JSON { "text": "..." } (also "message"/"body"/"content") or a plain
   text body. The secret can be sent as "Authorization: Bearer …" or ?secret=…
   Finds the customer by LEDGER-XXXXXX in the message, or else by the
   sender's phone number they entered in the app. */
app.post("/api/sms-webhook", requireSecret(process.env.SMS_WEBHOOK_SECRET), async (req, res) => {
  try {
    const b = req.body;
    const text = typeof b === "string" ? b : (b?.text || b?.message || b?.body || b?.content || b?.msg || "");
    const sender = typeof b === "object" && b ? String(b.from || b.sender || b.phone || "") : "";
    const parsed = parseIncomingSms(text);
    let ref = parsed.ref, record = ref ? await subGet(ref) : null, how = record ? "reference" : null;
    if (!record) {
      for (const ph of parsed.phones) {
        const refs = (await docGet("subphone:" + ph)) || [];
        for (let i = refs.length - 1; i >= 0 && !record; i--) { const r = await subGet(refs[i]); if (r) { record = r; ref = refs[i]; how = "phone " + ph; } }
        if (record) break;
      }
    }
    const short = parsed.raw.slice(0, 300);
    if (!record) {
      // Not every SMS is a payment (balance alerts, promos…). Keep it on the admin page in case it was one.
      if (parsed.amount != null) await logPayment({ result: "not matched", amount: parsed.amount, currency: parsed.currency, phones: parsed.phones, sender, sms: short, refInSms: parsed.ref });
      return res.json({ ok: true, matched: false, reason: parsed.ref ? `Reference ${parsed.ref} not found` : "No LEDGER- reference or known customer number in this message" });
    }
    const h = sha256(parsed.raw);
    record.seenSms = record.seenSms || [];
    if (record.seenSms.includes(h)) return res.json({ ok: true, matched: true, duplicate: true, unlocked: !!record.paid, ref: `LEDGER-${ref}`, renewedUntil: record.renewedUntil });
    record.lastAmount = parsed.amount; record.lastCurrency = parsed.currency; record.lastRawSms = short;
    record.seenSms = record.seenSms.slice(-9).concat(h);
    const check = checkAmount(record.country || DEFAULT_COUNTRY, parsed.amount, parsed.currency);
    if (check !== "ok") {
      // Don't unlock. Keep the details so you can review on /admin and unlock it by hand if it's genuine.
      record.pendingReview = { reason: check, amount: parsed.amount, currency: parsed.currency, at: today() };
      await subPut(ref, record);
      await logPayment({ result: "needs review (" + check + ")", ref: `LEDGER-${ref}`, how, amount: parsed.amount, currency: parsed.currency, sms: short });
      const p = priceFor(record.country || DEFAULT_COUNTRY);
      console.log(`⚠️  LEDGER-${ref}: payment NOT unlocked (${check}) — got ${parsed.currency || "?"} ${parsed.amount ?? "?"}, expected USD ${p.usd}${p.lrd ? ` or LRD ${p.lrd}` : ""}`);
      return res.json({ ok: true, matched: true, unlocked: false, reason: check, ref: `LEDGER-${ref}` });
    }
    extendSubscription(record);
    await subPut(ref, record);
    await logPayment({ result: "unlocked", ref: `LEDGER-${ref}`, how, amount: parsed.amount, currency: parsed.currency, until: record.renewedUntil, sms: short });
    console.log(`✅ Payment matched for LEDGER-${ref} (${how}) — active until ${record.renewedUntil}`);
    res.json({ ok: true, matched: true, unlocked: true, how, ref: `LEDGER-${ref}`, renewedUntil: record.renewedUntil });
  } catch (e) { console.error("sms-webhook:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ---- 4. Manual override — mark a reference paid by hand ----
   Useful if you confirm a payment yourself (e.g. saw it in your Orange Money
   app) and the SMS-forwarder missed it for some reason. */
async function markPaidByHand(refInput) {
  const code = String(refInput || "").replace(/^LEDGER-/i, "").toUpperCase();
  const rec = await subGet(code);
  if (!rec) return null;
  extendSubscription(rec);
  await subPut(code, rec);
  await logPayment({ result: "unlocked by hand", ref: `LEDGER-${code}`, until: rec.renewedUntil });
  return { ref: `LEDGER-${code}`, renewedUntil: rec.renewedUntil };
}
app.post("/api/mark-paid", requireSecret(process.env.SMS_WEBHOOK_SECRET), async (req, res) => {
  try {
    const r = await markPaidByHand(req.body?.ref);
    if (!r) return res.status(404).json({ ok: false, error: "Unknown reference code" });
    res.json(Object.assign({ ok: true }, r));
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ==================================================================
   MTN MoMo Open API — scaffolded, activates once .env is filled in.
   Docs: https://momodeveloper.mtn.com
   ================================================================== */
function momoConfigured() {
  return !!(process.env.MOMO_SUBSCRIPTION_KEY && process.env.MOMO_API_USER && process.env.MOMO_API_KEY);
}

async function getMomoAccessToken() {
  const basicAuth = Buffer.from(`${process.env.MOMO_API_USER}:${process.env.MOMO_API_KEY}`).toString("base64");
  const resp = await fetch(`${process.env.MOMO_BASE_URL}/collection/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Ocp-Apim-Subscription-Key": process.env.MOMO_SUBSCRIPTION_KEY,
    },
  });
  if (!resp.ok) throw new Error(`MTN token request failed: ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

// PWA calls this to start a MoMo "Request to Pay" — customer approves on their phone,
// then MTN calls /api/momo/callback automatically when it completes.
app.post("/api/momo/request-to-pay", async (req, res) => {
  if (!momoConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "MTN MoMo isn't set up yet. Fill in MOMO_SUBSCRIPTION_KEY, MOMO_API_USER, and MOMO_API_KEY in .env once your production access is approved. Until then, use the SMS-forwarding method — it already works.",
    });
  }
  // Amount and currency come from the server's PRICES, not from the request.
  const { phoneNumber, ref } = req.body || {};
  if (!phoneNumber || !ref) return res.status(400).json({ ok: false, error: "phoneNumber and ref are required" });
  const refCode = ref.replace(/^LEDGER-/i, "").toUpperCase();
  const country = (await subGet(refCode))?.country || DEFAULT_COUNTRY;
  const p = priceFor(country);
  const amount = p.momoCurrency === "LRD" ? p.lrd : p.usd;
  if (amount == null) return res.status(400).json({ ok: false, error: `No price set for ${country} in ${p.momoCurrency}` });

  try {
    const token = await getMomoAccessToken();
    const referenceId = crypto.randomUUID();
    const resp = await fetch(`${process.env.MOMO_BASE_URL}/collection/v1_0/requesttopay`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Reference-Id": referenceId,
        "X-Target-Environment": process.env.MOMO_TARGET_ENVIRONMENT || "mtnliberia",
        "Ocp-Apim-Subscription-Key": process.env.MOMO_SUBSCRIPTION_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amount.toFixed(2),
        currency: p.momoCurrency,
        externalId: ref,
        payer: { partyIdType: "MSISDN", partyId: phoneNumber },
        payerMessage: "The Ledger monthly subscription",
        payeeNote: ref,
      }),
    });
    if (resp.status !== 202) {
      const errText = await resp.text();
      throw new Error(`MTN request-to-pay failed: ${resp.status} ${errText}`);
    }
    // Remember which MTN referenceId maps to which of our ref codes, so the
    // callback (which only gives us referenceId) can find the right record.
    const code = ref.replace(/^LEDGER-/i, "").toUpperCase();
    const rec = await subGet(code);
    if (rec) { rec.momoReferenceId = referenceId; await subPut(code, rec); await docPut("submomo:" + referenceId, code); }
    res.json({ ok: true, referenceId, status: "PENDING" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// MTN calls this automatically when a Request-to-Pay completes.
// Configure this URL as your callback host in the MTN developer portal.
app.post("/api/momo/callback", async (req, res) => {
  console.log("MTN MoMo callback received:", JSON.stringify(req.body));
  try {
    const { referenceId, status } = req.body || {};
    if (status === "SUCCESSFUL" && referenceId) {
      const code = await docGet("submomo:" + referenceId);
      const rec = code ? await subGet(code) : null;
      if (rec) { extendSubscription(rec); await subPut(code, rec); await logPayment({ result: "unlocked (MTN MoMo)", ref: `LEDGER-${code}`, until: rec.renewedUntil }); console.log(`✅ MoMo payment confirmed for LEDGER-${code}`); }
    }
  } catch (e) { console.error("momo callback:", e.message); }
  res.sendStatus(200); // MTN just needs a 200 — no body required
});

/* ==================================================================
   STAFF ACCESS REQUESTS — lets a staff member on their own phone ask the
   owner for access, and the owner's phone see and answer it.
   Each shop is identified by shopId + shopKey, which the app derives from
   the ledger's own encryption key, so only phones that can open that
   ledger (owner or staff PIN) know them. The server never sees any
   business records — only the staff member's name and the request status.
   ================================================================== */
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// Returns the shop record (creating it on first use) or null if the key is wrong. Saved with docPut("staff:"+id).
async function openShop(shopId, shopKey) {
  if (!/^[a-f0-9]{24}$/.test(shopId || "") || !/^[a-f0-9]{64}$/.test(shopKey || "")) return null;
  const keyHash = sha256(shopKey);
  const shop = (await docGet("staff:" + shopId)) || { keyHash, requests: {} };
  if (shop.keyHash !== keyHash) return null;
  // tidy: forget answered requests older than 30 days
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [id, r] of Object.entries(shop.requests)) {
    if (r.status !== "pending" && Date.parse(r.decidedAt || r.at) < cutoff) delete shop.requests[id];
  }
  return shop;
}
const saveShop = (shopId, shop) => docPut("staff:" + shopId, shop);
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(req.path, e.message); res.status(500).json({ ok: false, error: "Server error" }); } };

// Staff phone sends a request
app.post("/api/staff/request", wrap(async (req, res) => {
  const { shopId, shopKey, requestId, name } = req.body || {};
  const shop = await openShop(shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!/^[A-Za-z0-9]{6,20}$/.test(requestId || "") || !cleanName) return res.status(400).json({ ok: false, error: "requestId and name are required" });
  const pendingCount = Object.values(shop.requests).filter((r) => r.status === "pending").length;
  if (!shop.requests[requestId] && pendingCount >= 50) return res.status(429).json({ ok: false, error: "Too many pending requests" });
  if (!shop.requests[requestId]) {
    shop.requests[requestId] = { id: requestId, name: cleanName, status: "pending", at: new Date().toISOString() };
    await saveShop(shopId, shop);
  }
  res.json({ ok: true, status: shop.requests[requestId].status });
}));

// Owner phone asks for pending requests
app.post("/api/staff/list", wrap(async (req, res) => {
  const { shopId, shopKey } = req.body || {};
  const shop = await openShop(shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  const requests = Object.values(shop.requests).filter((r) => r.status === "pending");
  res.json({ ok: true, requests });
}));

// Owner phone approves or declines
app.post("/api/staff/decide", wrap(async (req, res) => {
  const { shopId, shopKey, requestId, approve } = req.body || {};
  const shop = await openShop(shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  const r = shop.requests[requestId];
  if (!r) return res.status(404).json({ ok: false, error: "Unknown request" });
  r.status = approve ? "approved" : "declined";
  r.decidedAt = new Date().toISOString();
  await saveShop(shopId, shop);
  res.json({ ok: true, status: r.status });
}));

// Staff phone checks whether it was approved
app.post("/api/staff/status", wrap(async (req, res) => {
  const { shopId, shopKey, requestId } = req.body || {};
  const shop = await openShop(shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  const r = shop.requests[requestId];
  if (!r) return res.json({ ok: true, status: "unknown" });
  res.json({ ok: true, status: r.status, name: r.name });
}));

/* ==================================================================
   LIVE SYNC between the owner's and staff phones
   ------------------------------------------------------------------
   Each entry is encrypted ON THE PHONE with the ledger's own key before
   it is sent, so this server only ever sees scrambled text plus an entry
   id and a time. It cannot read sales, names or amounts.
   Storage: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (free at
   upstash.com) to keep data safe across restarts. Without them it uses
   local files, which Render's free plan wipes on restart — phones then
   notice (the "epoch" changes) and re-send everything automatically.
   ================================================================== */
const SYNC_DIR = path.join(__dirname, "data", "sync");
// Forgiving: the owner may paste the whole Upstash "REST" box (both lines, with names and quotes)
// into either setting on Render. We pick out the real URL and token from whatever was pasted.
const UPSTASH_PASTED = (process.env.UPSTASH_REDIS_REST_URL || "") + "\n" + (process.env.UPSTASH_REDIS_REST_TOKEN || "");
const REDIS_URL = ((UPSTASH_PASTED.match(/https:\/\/[^\s"'`]+/) || [""])[0]).replace(/\/+$/, "");
const REDIS_TOKEN = (() => {
  const named = UPSTASH_PASTED.match(/UPSTASH_REDIS_REST_TOKEN\s*[=:]\s*["'`]?([^"'`\s]+)/);
  if (named) return named[1];
  return (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim().replace(/^["'`]+|["'`]+$/g, "");
})();
const REDIS_TOKEN_HIDDEN = /^\*+$/.test(REDIS_TOKEN); // copied while Upstash showed ******** instead of the real token
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const SYNC_MAX_ITEMS_PER_SHOP = 300000; // ~100,000 sales plus expenses, stock moves, deletions…
const SYNC_PAGE_SIZE = 2000;            // entries per saved page (~1.2 MB, well under Upstash's 10 MB request limit)
const syncCache = new Map(); // shopId -> shop (kept in memory while in use, saved in the background)
const syncSaveTimers = new Map();

async function redisCmd(args) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
// Pages fill up in order: new entries go on the last page, so saving after a phone sends
// thousands of entries only rewrites the newest page(s), not the whole shop.
function placeNew(shop) {
  if (shop.pages === 0 || shop.fill >= SYNC_PAGE_SIZE) { shop.pages += 1; shop.fill = 0; }
  shop.fill += 1;
  return shop.pages - 1;
}
const K = { meta: (id) => "ledger-sync2:" + id + ":meta", page: (id, k) => "ledger-sync2:" + id + ":p:" + k, old: (id) => "ledger-sync:" + id };
const SYNC2_DIR = path.join(__dirname, "data", "sync2");
async function kvGet(key) {
  if (USE_REDIS) return redisCmd(["GET", key]);
  const f = path.join(SYNC2_DIR, encodeURIComponent(key));
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}
async function kvSet(key, text) {
  if (USE_REDIS) return redisCmd(["SET", key, text]);
  fs.mkdirSync(SYNC2_DIR, { recursive: true });
  fs.writeFileSync(path.join(SYNC2_DIR, encodeURIComponent(key)), text);
}
async function kvDel(key) {
  if (USE_REDIS) return redisCmd(["DEL", key]);
  const f = path.join(SYNC2_DIR, encodeURIComponent(key)); if (fs.existsSync(f)) fs.unlinkSync(f);
}
async function oldShopGet(shopId) { // format before paging (one big key / file)
  if (USE_REDIS) { const v = await redisCmd(["GET", K.old(shopId)]); return v ? JSON.parse(v) : null; }
  const f = path.join(SYNC_DIR, shopId + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
async function oldShopDel(shopId) {
  if (USE_REDIS) return redisCmd(["DEL", K.old(shopId)]);
  const f = path.join(SYNC_DIR, shopId + ".json"); if (fs.existsSync(f)) fs.unlinkSync(f);
}
// Entries in the order they changed, so "what changed since N" is a quick lookup instead of sorting everything.
function buildLog(shop) {
  shop.log = Object.entries(shop.items).map(([r, v]) => [v.s, r]).sort((a, b) => a[0] - b[0]);
  shop.count = Object.keys(shop.items).length;
}
function newShopObj(keyHash) { const s = { keyHash, epoch: crypto.randomBytes(8).toString("hex"), seq: 0, items: {}, pages: 0, fill: 0, dirty: new Set(), metaDirty: true, used: Date.now() }; buildLog(s); return s; }
async function syncStoreGet(shopId) {
  const metaTxt = await kvGet(K.meta(shopId));
  if (metaTxt) {
    const meta = JSON.parse(metaTxt);
    const shop = { keyHash: meta.keyHash, epoch: meta.epoch, seq: meta.seq, items: {}, pages: meta.pages || 0, fill: 0, dirty: new Set(), metaDirty: false, used: Date.now() };
    for (let k = 0; k < shop.pages; k += 8) {
      const ks = []; for (let j = k; j < Math.min(k + 8, shop.pages); j++) ks.push(j);
      const txts = await Promise.all(ks.map((j) => kvGet(K.page(shopId, j))));
      txts.forEach((txt, n) => {
        if (!txt) return;
        const pg = JSON.parse(txt), j = ks[n];
        for (const r in pg) { pg[r].p = j; shop.items[r] = pg[r]; }
        if (j === shop.pages - 1) shop.fill = Object.keys(pg).length;
      });
    }
    buildLog(shop);
    return shop;
  }
  const old = await oldShopGet(shopId);
  if (old) { // move an old single-key shop into pages (same epoch, so phones don't re-send anything)
    const shop = Object.assign(old, { pages: 0, fill: 0, dirty: new Set(), metaDirty: true, used: Date.now(), migratedFromOld: true });
    buildLog(shop);
    for (const [, r] of shop.log) { const p = placeNew(shop); shop.items[r].p = p; shop.dirty.add(p); }
    return shop;
  }
  return null;
}
async function syncStorePut(shopId, shop) {
  const pages = Array.from(shop.dirty); shop.dirty = new Set();
  try {
    if (pages.length) {
      const buckets = new Map(pages.map((k) => [k, {}]));
      for (const r in shop.items) { const v = shop.items[r]; const b = buckets.get(v.p); if (b) b[r] = { u: v.u, s: v.s, iv: v.iv, d: v.d }; }
      for (let i = 0; i < pages.length; i += 8) await Promise.all(pages.slice(i, i + 8).map((k) => kvSet(K.page(shopId, k), JSON.stringify(buckets.get(k)))));
    }
    if (pages.length || shop.metaDirty) {
      await kvSet(K.meta(shopId), JSON.stringify({ v: 2, keyHash: shop.keyHash, epoch: shop.epoch, seq: shop.seq, pages: shop.pages, count: shop.count }));
      shop.metaDirty = false;
    }
    if (shop.migratedFromOld) { await oldShopDel(shopId); shop.migratedFromOld = false; }
  } catch (e) { pages.forEach((k) => shop.dirty.add(k)); throw e; }
}
function syncSaveSoon(shopId) {
  if (syncSaveTimers.has(shopId)) return;
  syncSaveTimers.set(shopId, setTimeout(async () => {
    syncSaveTimers.delete(shopId);
    const shop = syncCache.get(shopId); if (!shop) return;
    try { await syncStorePut(shopId, shop); }
    catch (e) { console.error("Sync save failed for", shopId, e.message); setTimeout(() => syncSaveSoon(shopId), 3000); }
  }, 2000));
}
// Free memory: forget shops nobody has used for 20 minutes (they're saved; they reload on the next request).
setInterval(() => {
  const now = Date.now();
  for (const [id, shop] of syncCache) {
    if (now - (shop.used || 0) > 20 * 60 * 1000 && !shop.dirty.size && !shop.metaDirty && !syncSaveTimers.has(id)) syncCache.delete(id);
  }
}, 5 * 60 * 1000).unref?.();
// Returns the shop (creating it on first use) or null if the key is wrong.
const syncLoading = new Map();
async function openSyncShop(shopId, shopKey) {
  if (!/^[a-f0-9]{24}$/.test(shopId || "") || !/^[a-f0-9]{64}$/.test(shopKey || "")) return null;
  const keyHash = sha256(shopKey);
  let shop = syncCache.get(shopId);
  if (!shop) {
    if (!syncLoading.has(shopId)) syncLoading.set(shopId, (async () => {
      let s = await syncStoreGet(shopId);
      if (!s) s = newShopObj(keyHash);
      if (s.metaDirty || s.dirty.size) syncSaveSoon(shopId);
      syncCache.set(shopId, s);
      return s;
    })().finally(() => syncLoading.delete(shopId)));
    shop = await syncLoading.get(shopId);
  }
  if (shop.keyHash !== keyHash) return null;
  shop.used = Date.now();
  return shop;
}

// Phone sends new or changed entries (already encrypted)
app.post("/api/sync/push", async (req, res) => {
  try {
    const { shopId, shopKey, items } = req.body || {};
    const shop = await openSyncShop(shopId, shopKey);
    if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
    if (!Array.isArray(items) || items.length > 400) return res.status(400).json({ ok: false, error: "Send 1–400 items at a time" });
    let stored = 0;
    for (const it of items) {
      if (!it || typeof it.r !== "string" || it.r.length > 80 || typeof it.u !== "string" || it.u.length > 40) continue;
      if (typeof it.iv !== "string" || it.iv.length > 40 || typeof it.d !== "string" || it.d.length > 40000) continue;
      const old = shop.items[it.r];
      if (old && old.u >= it.u) continue; // server already has this version or a newer one
      if (!old && shop.count >= SYNC_MAX_ITEMS_PER_SHOP) return res.status(413).json({ ok: false, error: "Shop is full" });
      shop.seq += 1;
      const pg = old ? old.p : placeNew(shop);
      shop.items[it.r] = { u: it.u, s: shop.seq, iv: it.iv, d: it.d, p: pg };
      if (!old) shop.count++;
      shop.log.push([shop.seq, it.r]);
      shop.dirty.add(pg); shop.metaDirty = true;
      stored++;
    }
    if (shop.log.length > shop.count * 2 + 1000) buildLog(shop); // drop stale log entries now and then
    if (stored) syncSaveSoon(shopId);
    res.json({ ok: true, epoch: shop.epoch, seq: shop.seq, stored });
  } catch (e) {
    console.error("sync/push:", e.message);
    res.status(500).json({ ok: false, error: "Server error: " + String(e.message || e).slice(0, 140) });
  }
});

// Phone asks for everything that changed since it last asked
app.post("/api/sync/pull", async (req, res) => {
  try {
    const { shopId, shopKey } = req.body || {};
    const since = Math.max(0, parseInt((req.body || {}).since, 10) || 0);
    const shop = await openSyncShop(shopId, shopKey);
    if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
    const LIMIT = 500;
    // binary search: first log entry after `since`
    let lo = 0, hi = shop.log.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (shop.log[mid][0] <= since) lo = mid + 1; else hi = mid; }
    const items = []; let last = since, i = lo;
    for (; i < shop.log.length && items.length < LIMIT; i++) {
      const [s, r] = shop.log[i]; const v = shop.items[r];
      last = s;
      if (!v || v.s !== s) continue; // an older version of an entry that changed again later
      items.push({ r, u: v.u, iv: v.iv, d: v.d });
    }
    const more = i < shop.log.length;
    res.json({ ok: true, epoch: shop.epoch, seq: more ? last : shop.seq, more, items });
  } catch (e) {
    console.error("sync/pull:", e.message);
    res.status(500).json({ ok: false, error: "Server error: " + String(e.message || e).slice(0, 140) });
  }
});

/* ==================================================================
   RECOVERY: lets an owner get their business back on a new phone
   ------------------------------------------------------------------
   Stores the ledger key LOCKED with the owner's secret recovery code.
   The server never sees the code — only a fingerprint (id + key hash) —
   so it can't open anything. Uses the same storage as live sync.
   ================================================================== */
const RECOVERY_DIR = path.join(__dirname, "data", "recovery");
async function recoveryGet(id) {
  if (USE_REDIS) { const v = await redisCmd(["GET", "ledger-recovery:" + id]); return v ? JSON.parse(v) : null; }
  const f = path.join(RECOVERY_DIR, id + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
async function recoveryPut(id, rec) {
  if (USE_REDIS) return redisCmd(["SET", "ledger-recovery:" + id, JSON.stringify(rec)]);
  fs.mkdirSync(RECOVERY_DIR, { recursive: true });
  fs.writeFileSync(path.join(RECOVERY_DIR, id + ".json"), JSON.stringify(rec));
}
async function recoveryDel(id) {
  if (USE_REDIS) return redisCmd(["DEL", "ledger-recovery:" + id]);
  const f = path.join(RECOVERY_DIR, id + ".json");
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
function validRecoveryIds(b) { return b && /^[a-f0-9]{24}$/.test(b.id || "") && /^[a-f0-9]{64}$/.test(b.key || ""); }

app.post("/api/recovery/save", async (req, res) => {
  try {
    const b = req.body || {};
    if (!validRecoveryIds(b) || !b.blob || typeof b.blob.iv !== "string" || typeof b.blob.data !== "string" || b.blob.data.length > 8000)
      return res.status(400).json({ ok: false, error: "Bad request" });
    const keyHash = sha256(b.key);
    const old = await recoveryGet(b.id);
    if (old && old.keyHash !== keyHash) return res.status(401).json({ ok: false, error: "Wrong key" });
    await recoveryPut(b.id, { keyHash, blob: { iv: b.blob.iv, data: b.blob.data }, at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { console.error("recovery/save:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/recovery/get", async (req, res) => {
  try {
    const b = req.body || {};
    if (!validRecoveryIds(b)) return res.status(400).json({ ok: false, error: "Bad request" });
    const rec = await recoveryGet(b.id);
    if (!rec || rec.keyHash !== sha256(b.key)) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, blob: rec.blob, at: rec.at });
  } catch (e) { console.error("recovery/get:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/recovery/delete", async (req, res) => {
  try {
    const b = req.body || {};
    if (!validRecoveryIds(b)) return res.status(400).json({ ok: false, error: "Bad request" });
    const rec = await recoveryGet(b.id);
    if (rec && rec.keyHash === sha256(b.key)) await recoveryDel(b.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ==================================================================
   STAFF SETUP LINKS — set up a staff phone without sending a file
   ------------------------------------------------------------------
   The owner's phone uploads its backup (still ENCRYPTED with the owner
   and staff PINs — the server can't read it) and gets a short code.
   The staff phone opens the link / types the code, downloads it, and
   unlocks it with the staff PIN. Codes expire after 48 hours.
   ================================================================== */
const JOIN_DIR = path.join(__dirname, "data", "join");
const JOIN_TTL_SEC = 48 * 3600;
const JOIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newJoinCode() { const b = crypto.randomBytes(8); let c = ""; for (const x of b) c += JOIN_ALPHABET[x % JOIN_ALPHABET.length]; return c; }
function cleanJoinCode(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
async function joinPut(code, text) {
  if (USE_REDIS) return redisCmd(["SET", "ledger-join:" + code, text, "EX", String(JOIN_TTL_SEC)]);
  fs.mkdirSync(JOIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(JOIN_DIR, code + ".json"), JSON.stringify({ text, exp: Date.now() + JOIN_TTL_SEC * 1000 }));
}
async function joinGet(code) {
  if (USE_REDIS) return redisCmd(["GET", "ledger-join:" + code]);
  const f = path.join(JOIN_DIR, code + ".json");
  if (!fs.existsSync(f)) return null;
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  if (r.exp < Date.now()) { fs.unlinkSync(f); return null; }
  return r.text;
}
// Slow down anyone guessing codes: at most 30 look-ups per 10 minutes from one address.
const joinHits = new Map();
function joinTooMany(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (joinHits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); joinHits.set(ip, list);
  if (joinHits.size > 5000) joinHits.clear();
  return list.length > 30;
}
app.post("/api/join/save", async (req, res) => {
  try {
    const text = (req.body || {}).file;
    if (typeof text !== "string" || text.length < 20 || text.length > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: "Bad request" });
    let d; try { d = JSON.parse(text); } catch (e) { return res.status(400).json({ ok: false, error: "Not a backup" }); }
    if (!d || d.app !== "ledger-backup" || !d.blob) return res.status(400).json({ ok: false, error: "Not a backup" });
    const code = newJoinCode();
    await joinPut(code, text);
    res.json({ ok: true, code, expiresAt: new Date(Date.now() + JOIN_TTL_SEC * 1000).toISOString() });
  } catch (e) { console.error("join/save:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/join/get", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?";
    if (joinTooMany(ip)) return res.status(429).json({ ok: false, error: "Too many tries — wait 10 minutes" });
    const code = cleanJoinCode((req.body || {}).code);
    if (code.length !== 8) return res.status(400).json({ ok: false, error: "The code has 8 letters and numbers" });
    const text = await joinGet(code);
    if (!text) return res.status(404).json({ ok: false, error: "Code not found or expired" });
    res.json({ ok: true, file: text });
  } catch (e) { console.error("join/get:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ==================================================================
   ANONYMOUS USAGE COUNT — for the app's builder only
   ------------------------------------------------------------------
   Phones send: a random device ID, country (from the phone's time zone),
   app version, owner/staff, browser, installed or not, and a one-way
   scrambled business code. No sales, names, amounts or records — ever.
   The dashboard is at /admin and needs ADMIN_KEY (set it on Render).
   ================================================================== */
const USAGE_DIR = path.join(__dirname, "data", "usage");
const USAGE_DAYS_KEPT = 40;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const dayKey = (d) => d.toISOString().slice(0, 10);
async function usageWrite(day, device, rec) {
  const v = JSON.stringify(rec);
  if (USE_REDIS) {
    await redisCmd(["HSET", "ledger-usage:" + day, device, v]);
    await redisCmd(["EXPIRE", "ledger-usage:" + day, String(USAGE_DAYS_KEPT * 86400)]);
    return;
  }
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  const f = path.join(USAGE_DIR, day + ".json");
  const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  all[device] = rec;
  fs.writeFileSync(f, JSON.stringify(all));
}
async function usageReadDay(day) {
  if (USE_REDIS) {
    const arr = (await redisCmd(["HGETALL", "ledger-usage:" + day])) || [];
    const out = {};
    for (let i = 0; i + 1 < arr.length; i += 2) { try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch (e) {} }
    return out;
  }
  const f = path.join(USAGE_DIR, day + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

app.post("/api/usage/ping", async (req, res) => {
  try {
    const b = req.body || {};
    const device = String(b.device || "");
    const country = String(b.country || "??").slice(0, 48);
    if (!/^[a-f0-9]{24}$/.test(device)) return res.status(400).json({ ok: false, error: "Bad device" });
    if (!/^([A-Z]{2}|\?\?|TZ:[A-Za-z_\/+\-0-9]{1,44})$/.test(country)) return res.status(400).json({ ok: false, error: "Bad country" });
    const rec = {
      c: country,
      v: /^v\d{1,4}$/.test(b.version || "") ? b.version : "?",
      r: ["owner", "staff"].includes(b.role) ? b.role : "",
      b: /^[a-f0-9]{16}$/.test(b.biz || "") ? b.biz : "",
      br: ["Chrome", "Edge", "Safari", "Firefox", "Other"].includes(b.browser) ? b.browser : "Other",
      i: !!b.installed,
      t: new Date().toISOString(),
    };
    // keep owner/staff and business code from earlier the same day (the lock screen doesn't know them)
    const day = dayKey(new Date());
    try {
      let prev = null;
      if (USE_REDIS) { const v = await redisCmd(["HGET", "ledger-usage:" + day, device]); prev = v ? JSON.parse(v) : null; }
      else { prev = (await usageReadDay(day))[device] || null; }
      if (prev) { if (!rec.r) rec.r = prev.r || ""; if (!rec.b) rec.b = prev.b || ""; }
    } catch (e) {}
    await usageWrite(day, device, rec);
    res.json({ ok: true });
  } catch (e) {
    console.error("usage/ping:", e.message);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

function adminOk(req) {
  if (!ADMIN_KEY) return false;
  const given = Buffer.from(String(req.get("x-admin-key") || ""));
  const want = Buffer.from(ADMIN_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
app.get("/api/admin/stats", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ ok: false, error: "ADMIN_KEY is not set on the server yet" });
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Wrong admin key" });
  try {
    const now = new Date();
    const days = [];
    for (let i = 0; i < 30; i++) { const d = new Date(now.getTime() - i * 86400000); days.push(dayKey(d)); }
    const perDay = await Promise.all(days.map(usageReadDay));
    const countries = {};
    const latest = {}; // newest record per device (within 30 days)
    const daily = days.map((d, i) => ({ day: d, active: Object.keys(perDay[i]).length }));
    const bump = (c, field, key) => { countries[c] = countries[c] || { today: new Set(), d7: new Set(), d30: new Set(), biz30: new Set(), owners: new Set(), staff: new Set() }; countries[c][field].add(key); };
    perDay.forEach((recs, i) => {
      for (const [dev, r] of Object.entries(recs)) {
        if (i === 0) bump(r.c, "today", dev);
        if (i < 7) bump(r.c, "d7", dev);
        bump(r.c, "d30", dev);
        if (r.b) bump(r.c, "biz30", r.b);
        if (r.r === "owner") bump(r.c, "owners", dev);
        if (r.r === "staff") bump(r.c, "staff", dev);
        if (!latest[dev] || latest[dev].t < r.t) latest[dev] = r;
      }
    });
    const tally = (fn) => { const o = {}; Object.values(latest).forEach((r) => { const k = fn(r); o[k] = (o[k] || 0) + 1; }); return o; };
    const rows = Object.entries(countries).map(([c, s]) => ({
      country: c, today: s.today.size, last7: s.d7.size, last30: s.d30.size, businesses: s.biz30.size, owners: s.owners.size, staff: s.staff.size,
    })).sort((a, b) => b.last7 - a.last7 || b.last30 - a.last30);
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    res.json({
      ok: true,
      generatedAt: now.toISOString(),
      totals: { today: sum("today"), last7: sum("last7"), last30: sum("last30"), businesses: sum("businesses") },
      countries: rows,
      versions: tally((r) => r.v),
      browsers: tally((r) => r.br),
      installed: tally((r) => (r.i ? "Installed app" : "In browser")),
      daily: daily.reverse(),
    });
  } catch (e) {
    console.error("admin/stats:", e.message);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Recent payment messages for the builder (to check payments and unlock by hand).
app.get("/api/admin/payments", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ ok: false, error: "ADMIN_KEY is not set on the server yet" });
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Wrong admin key" });
  try { res.json({ ok: true, log: (await docGet("paylog")) || [], webhookReady: !!process.env.SMS_WEBHOOK_SECRET }); }
  catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/admin/mark-paid", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ ok: false, error: "ADMIN_KEY is not set on the server yet" });
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Wrong admin key" });
  try { const r = await markPaidByHand(req.body?.ref); if (!r) return res.status(404).json({ ok: false, error: "Unknown reference code" }); res.json(Object.assign({ ok: true }, r)); }
  catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.get("/admin", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(ADMIN_PAGE);
});
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Ledger — Builder dashboard</title><meta name="robots" content="noindex">
<style>
:root{--ink:#1C2431;--paper:#F0E9D6;--line:#DDD2B4;--gold:#C39B3C;--green:#3F6B4A;--muted:#6B6558;--card:#FFFDF7}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:var(--ink);color:#FFF8EA;padding:16px}header h1{font-family:Georgia,serif;font-size:20px;margin:0}header p{margin:4px 0 0;font-size:12.5px;color:#C7CCD6}
main{max-width:900px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.tile b{display:block;font-size:28px;font-family:Georgia,serif}.tile span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 6px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}th{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px}
.bar{height:8px;background:var(--gold);border-radius:4px;margin-top:4px}
input{font-size:15px;padding:10px;border:1px solid var(--line);border-radius:6px;width:100%}button{font-size:15px;font-weight:700;color:#FFF8EA;background:var(--ink);border:none;border-radius:6px;padding:11px 16px;cursor:pointer}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:#fff;border:1px solid var(--line);border-radius:16px;padding:5px 10px;font-size:13px}
.err{color:#8B3A3A;font-size:13px;margin-top:8px}.muted{color:var(--muted);font-size:12.5px}
.spark{display:flex;align-items:flex-end;gap:3px;height:80px}.spark div{flex:1;background:var(--green);border-radius:2px 2px 0 0;min-height:2px}
</style></head><body>
<header><h1>📘 The Ledger — Builder dashboard</h1><p>Active users per country. Anonymous counts only — no business records.</p></header>
<main>
  <div class="card" id="login"><b>Admin key</b><p class="muted">The ADMIN_KEY you set on Render. It is remembered on this device.</p>
    <div style="display:flex;gap:8px;"><input id="key" type="password" placeholder="Admin key"><button id="go">Open</button></div><div class="err" id="err"></div></div>
  <div id="dash" style="display:none">
    <div class="tiles">
      <div class="tile"><span>Active today</span><b id="t-today">0</b></div>
      <div class="tile"><span>Last 7 days</span><b id="t-7">0</b></div>
      <div class="tile"><span>Last 30 days</span><b id="t-30">0</b></div>
      <div class="tile"><span>Businesses (30 days)</span><b id="t-biz">0</b></div>
    </div>
    <div class="card"><b>Active phones per country</b><p class="muted">A phone counts as active if it opened the app in that period.</p><div style="overflow-x:auto"><table id="tbl"></table></div></div>
    <div class="card"><b>Daily active phones (30 days)</b><div class="spark" id="spark" style="margin-top:12px"></div><div class="muted" id="spark-lbl" style="display:flex;justify-content:space-between;margin-top:4px"></div></div>
    <div class="card"><b>App versions in use</b><p class="muted">Shows who still needs to update.</p><div class="chips" id="ver"></div></div>
    <div class="card"><b>Browsers</b><div class="chips" id="br"></div><p style="margin:12px 0 0"><b>Installed vs browser</b></p><div class="chips" id="ins" style="margin-top:8px"></div></div>
    <div class="card"><b>💰 Payments</b><p class="muted" id="pay-note">Orange Money messages forwarded to the server, newest first.</p>
      <div style="display:flex;gap:8px;margin:8px 0 12px;"><input id="mp-ref" placeholder="LEDGER-XXXXXX"><button id="mp-go" style="white-space:nowrap">Unlock by hand</button></div>
      <div class="err" id="mp-msg"></div>
      <div style="overflow-x:auto"><table id="pay"></table></div></div>
    <p class="muted" id="gen"></p><button id="refresh">↻ Refresh</button> <button id="logout" style="background:#fff;color:var(--ink);border:1px solid var(--line)">Forget key</button>
  </div>
</main>
<script>
const $=id=>document.getElementById(id);
let names=null;try{names=new Intl.DisplayNames(["en"],{type:"region"});}catch(e){}
const flag=c=>/^[A-Z]{2}$/.test(c)?String.fromCodePoint(...[...c].map(ch=>127397+ch.charCodeAt(0))):"🌐";
const cname=c=>/^[A-Z]{2}$/.test(c)?((names&&names.of(c))||c):(c==="??"?"Unknown":c.replace(/^TZ:/,"Time zone "));
const chips=(el,o)=>{el.innerHTML=Object.entries(o).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<span class="chip">'+k+' · <b>'+v+'</b></span>').join("")||'<span class="muted">No data yet</span>';};
async function load(){
  const key=localStorage.getItem("ledger-admin-key")||"";
  if(!key){$("login").style.display="block";$("dash").style.display="none";return;}
  $("err").textContent="Loading…";
  let r,d;try{r=await fetch("/api/admin/stats",{headers:{"x-admin-key":key},cache:"no-store"});d=await r.json();}catch(e){$("err").textContent="Could not reach the server (it may be waking up — try again in a minute).";return;}
  if(!d.ok){$("err").textContent=d.error||"Error";if(r.status===401)localStorage.removeItem("ledger-admin-key");$("login").style.display="block";$("dash").style.display="none";return;}
  $("err").textContent="";$("login").style.display="none";$("dash").style.display="block";
  $("t-today").textContent=d.totals.today;$("t-7").textContent=d.totals.last7;$("t-30").textContent=d.totals.last30;$("t-biz").textContent=d.totals.businesses;
  const max=Math.max(1,...d.countries.map(x=>x.last7));
  $("tbl").innerHTML='<tr><th>Country</th><th>Today</th><th>7 days</th><th>30 days</th><th>Businesses</th><th>Owners / staff</th></tr>'+
    (d.countries.map(x=>'<tr><td>'+flag(x.country)+' '+cname(x.country)+'<div class="bar" style="width:'+Math.round(100*x.last7/max)+'%"></div></td><td>'+x.today+'</td><td><b>'+x.last7+'</b></td><td>'+x.last30+'</td><td>'+x.businesses+'</td><td>'+x.owners+' / '+x.staff+'</td></tr>').join("")||'<tr><td colspan="6" class="muted">No active users yet.</td></tr>');
  const dm=Math.max(1,...d.daily.map(x=>x.active));
  $("spark").innerHTML=d.daily.map(x=>'<div title="'+x.day+': '+x.active+'" style="height:'+Math.round(100*x.active/dm)+'%"></div>').join("");
  $("spark-lbl").innerHTML='<span>'+d.daily[0].day+'</span><span>'+d.daily[d.daily.length-1].day+'</span>';
  chips($("ver"),d.versions);chips($("br"),d.browsers);chips($("ins"),d.installed);
  $("gen").textContent="Updated "+new Date(d.generatedAt).toLocaleString();
  loadPayments();
}
const esc=t=>String(t==null?"":t).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function loadPayments(){
  const key=localStorage.getItem("ledger-admin-key")||"";
  let d;try{d=await (await fetch("/api/admin/payments",{headers:{"x-admin-key":key},cache:"no-store"})).json();}catch(e){return;}
  if(!d.ok)return;
  $("pay-note").innerHTML=d.webhookReady?"Orange Money messages forwarded to the server, newest first.":"<b style='color:#8B3A3A'>SMS_WEBHOOK_SECRET is not set on Render yet — payments can't arrive automatically.</b>";
  $("pay").innerHTML='<tr><th>When</th><th>Result</th><th>Code / number</th><th>Amount</th></tr>'+(d.log.map(e=>'<tr><td>'+esc(new Date(e.at).toLocaleString())+'</td><td style="text-align:left">'+esc(e.result)+(e.until?'<div class="muted">until '+esc(e.until)+'</div>':'')+'</td><td style="text-align:left">'+esc(e.ref||"")+(e.how?'<div class="muted">'+esc(e.how)+'</div>':'')+(e.phones&&e.phones.length?'<div class="muted">from '+esc(e.phones.join(", "))+'</div>':'')+(e.sms?'<div class="muted" style="max-width:340px;white-space:normal">'+esc(e.sms)+'</div>':'')+'</td><td>'+esc(e.amount!=null?(e.currency||"")+" "+e.amount:"")+'</td></tr>').join("")||'<tr><td colspan="4" class="muted">No payment messages yet.</td></tr>');
}
$("mp-go").onclick=async()=>{const key=localStorage.getItem("ledger-admin-key")||"";const ref=$("mp-ref").value.trim();if(!ref)return;
  let d;try{d=await (await fetch("/api/admin/mark-paid",{method:"POST",headers:{"x-admin-key":key,"Content-Type":"application/json"},body:JSON.stringify({ref})})).json();}catch(e){$("mp-msg").textContent="Could not reach the server.";return;}
  $("mp-msg").textContent=d.ok?("✓ "+d.ref+" unlocked until "+d.renewedUntil+". The customer taps “Check payment now”."):(d.error||"Error");loadPayments();};
$("go").onclick=()=>{localStorage.setItem("ledger-admin-key",$("key").value.trim());load();};
$("key").onkeydown=e=>{if(e.key==="Enter")$("go").click();};
$("refresh").onclick=load;$("logout").onclick=()=>{localStorage.removeItem("ledger-admin-key");location.reload();};
load();
</script></body></html>`;

app.listen(PORT, () => {
  migrateOldFiles();
  console.log(`The Ledger payment backend running on port ${PORT}`);
  console.log(`Liberia price: USD ${PRICES.LR.usd}${PRICES.LR.lrd ? ` / LRD ${PRICES.LR.lrd}` : " (LRD not auto-accepted)"}`);
  console.log(`MTN MoMo configured: ${momoConfigured() ? "yes" : "no (SMS-forwarding is active instead)"}`);
  console.log(`Builder dashboard: /admin (${ADMIN_KEY ? "admin key set" : "set ADMIN_KEY to turn it on"})`);
  console.log(`Live sync storage: ${USE_REDIS ? "Upstash Redis (kept across restarts)" : "local files (wiped when Render restarts; phones re-send automatically)"}`);
  console.log(`Payments & staff requests storage: ${USE_REDIS ? "Upstash Redis (kept across restarts)" : "local files (testing only)"}`);
  console.log(`SMS payment webhook: ${process.env.SMS_WEBHOOK_SECRET ? "ready" : "NOT ready — set SMS_WEBHOOK_SECRET"}`);
});
