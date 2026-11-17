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
app.use(express.urlencoded({ extended: false, limit: "1mb" })); // …and some post web-form style

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
const MAX_MONTHS = 12; // a customer can pay for up to 12 months at once
function clampMonths(m) { m = Math.floor(Number(m) || 1); return Math.min(MAX_MONTHS, Math.max(1, m)); }
/* How many whole months an amount pays for (US$6 → 3 months). */
function monthsPaidFor(country, amount, currency) {
  const p = priceFor(country);
  const each = currency === "LRD" ? p.lrd : p.usd;
  if (!each || amount == null) return 1;
  return clampMonths(Math.floor((amount + 0.001) / each));
}
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
/* A phone keeps its LEDGER- code for good, but codes made before the server used Redis were lost
   when Render restarted. If a phone shows a real-looking code the server doesn't know, take it back in. */
const okRef = (code) => /^[A-F0-9]{6}$/.test(String(code || ""));
async function subGetOrCreate(code) {
  code = String(code || "").replace(/^LEDGER-/i, "").trim().toUpperCase();
  if (!okRef(code)) return null;
  let rec = await subGet(code);
  if (!rec) { rec = { createdAt: today(), country: DEFAULT_COUNTRY, paid: false, paidAt: null, renewedUntil: null, lastAmount: null, lastRawSms: null, restored: true }; await subPut(code, rec); }
  return rec;
}
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
    const provided = String(req.get("Authorization")?.replace(/^Bearer\s+/i, "") || (req.body && typeof req.body === "object" ? req.body.secret : "") || req.query.secret || "").trim();
    if (!expected || provided !== String(expected).trim()) {
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
const SERVER_VERSION = "v32";
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
    const rec = code ? await subGetOrCreate(code) : null;
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
    const record = await subGetOrCreate(code);
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
function extendSubscription(record, months) {
  months = clampMonths(months);
  const base = record.renewedUntil && record.renewedUntil > today() ? record.renewedUntil : today();
  record.paid = true;
  record.paidAt = today();
  record.renewedUntil = addDays(base, SUBSCRIPTION_DAYS * months);
  record.lastMonths = months;
  delete record.pendingReview;
  return record;
}

/* ---- 3. SMS-forwarder app posts every incoming SMS here ----
   Protect this with SMS_WEBHOOK_SECRET so a stranger can't fake payments.
   Accepts JSON { "text": "..." } (also "message"/"body"/"content") or a plain
   text body. The secret can be sent as "Authorization: Bearer …" or ?secret=…
   Finds the customer by LEDGER-XXXXXX in the message, or else by the
   sender's phone number they entered in the app. */
// Works with any SMS-forwarder app: GET or POST, JSON, web-form or plain text, any field names.
function readForwardedSms(req) {
  const fields = Object.assign({}, req.query || {}, (req.body && typeof req.body === "object") ? req.body : {});
  delete fields.secret;
  const pick = (keys) => { for (const k of Object.keys(fields)) if (keys.includes(k.toLowerCase()) && fields[k] != null && String(fields[k]).trim()) return String(fields[k]); return ""; };
  let text = typeof req.body === "string" ? req.body : pick(["text", "message", "body", "content", "msg", "sms", "smstext", "message_body", "messagebody"]);
  if (!text) { // unknown app: use every text value it sent
    const all = []; const walk = (v) => { if (v == null) return; if (typeof v === "object") Object.values(v).forEach(walk); else all.push(String(v)); };
    walk(fields); text = all.join("\n");
  }
  const sender = pick(["from", "sender", "phone", "number", "address", "originator", "src", "msisdn"]);
  return { text, sender };
}
app.all("/api/sms-webhook", requireSecret(process.env.SMS_WEBHOOK_SECRET), async (req, res) => {
  try {
    const { text, sender } = readForwardedSms(req);
    const parsed = parseIncomingSms(text);
    let ref = parsed.ref, record = ref ? await subGetOrCreate(ref) : null, how = record ? "reference" : null;
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
      else await logPayment({ result: "SMS received (not a payment)", sender, sms: parsed.raw.slice(0, 80) }); // shows on /admin, handy to test the forwarder phone
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
    const months = monthsPaidFor(record.country || DEFAULT_COUNTRY, parsed.amount, parsed.currency);
    extendSubscription(record, months);
    await subPut(ref, record);
    await logPayment({ result: "unlocked" + (months > 1 ? ` (${months} months)` : ""), ref: `LEDGER-${ref}`, how, amount: parsed.amount, currency: parsed.currency, until: record.renewedUntil, sms: short });
    console.log(`✅ Payment matched for LEDGER-${ref} (${how}) — active until ${record.renewedUntil}`);
    res.json({ ok: true, matched: true, unlocked: true, how, ref: `LEDGER-${ref}`, renewedUntil: record.renewedUntil });
  } catch (e) { console.error("sms-webhook:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ---- 4. Manual override — mark a reference paid by hand ----
   Useful if you confirm a payment yourself (e.g. saw it in your Orange Money
   app) and the SMS-forwarder missed it for some reason. */
async function markPaidByHand(refInput, monthsInput) {
  const code = String(refInput || "").replace(/^LEDGER-/i, "").trim().toUpperCase();
  const rec = await subGetOrCreate(code);
  if (!rec) return null;
  const months = clampMonths(monthsInput);
  extendSubscription(rec, months);
  await subPut(code, rec);
  await logPayment({ result: "unlocked by hand" + (months > 1 ? ` (${months} months)` : ""), ref: `LEDGER-${code}`, until: rec.renewedUntil });
  return { ref: `LEDGER-${code}`, renewedUntil: rec.renewedUntil, months };
}
app.post("/api/mark-paid", requireSecret(process.env.SMS_WEBHOOK_SECRET), async (req, res) => {
  try {
    const r = await markPaidByHand(req.body?.ref, req.body?.months);
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
   MAILBOXES — shops and their suppliers send each other orders
   ------------------------------------------------------------------
   Every message is locked (encrypted) on the phone before it is sent.
   The server cannot read it: it only keeps it for a while (60 days,
   the newest 300 per mailbox) and gives it to whoever asks for that
   mailbox. A mailbox name is a 64-character code that only the shop
   and its supplier can work out.
   ================================================================== */
const MAIL_TTL_SEC = 60 * 24 * 3600, MAIL_MAX = 300, MAIL_MSG_MAX = 64 * 1024;
const MAIL_DIR = path.join(__dirname, "data", "mail");
let mailLastAt = 0;
function okBox(b) { return typeof b === "string" && /^[a-f0-9]{64}$/.test(b); }
async function mailPush(box, item) {
  const j = JSON.stringify(item);
  if (USE_REDIS) {
    await redisCmd(["RPUSH", "mail:" + box, j]);
    await redisCmd(["LTRIM", "mail:" + box, String(-MAIL_MAX), "-1"]);
    await redisCmd(["EXPIRE", "mail:" + box, String(MAIL_TTL_SEC)]);
    return;
  }
  fs.mkdirSync(MAIL_DIR, { recursive: true });
  const f = path.join(MAIL_DIR, box + ".json");
  const arr = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
  arr.push(item);
  fs.writeFileSync(f, JSON.stringify(arr.slice(-MAIL_MAX)));
}
async function mailList(box) {
  if (USE_REDIS) {
    const arr = (await redisCmd(["LRANGE", "mail:" + box, "0", "-1"])) || [];
    return arr.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  }
  const f = path.join(MAIL_DIR, box + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
}
const mailHits = new Map();
function mailTooMany(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (mailHits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); mailHits.set(ip, list);
  if (mailHits.size > 5000) mailHits.clear();
  return list.length > 200;
}
app.post("/api/mail/send", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?";
    if (mailTooMany(ip)) return res.status(429).json({ ok: false, error: "Too many messages — wait a few minutes" });
    const { box, msg } = req.body || {};
    if (!okBox(box) || !msg || typeof msg !== "object") return res.status(400).json({ ok: false, error: "Bad request" });
    const text = JSON.stringify(msg);
    if (text.length > MAIL_MSG_MAX) return res.status(413).json({ ok: false, error: "Message too big" });
    const at = Math.max(Date.now(), mailLastAt + 1); mailLastAt = at;
    const id = at.toString(36) + "-" + crypto.randomBytes(4).toString("hex");
    await mailPush(box, { id, at, msg });
    res.json({ ok: true, id, at });
  } catch (e) { console.error("mail/send:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/mail/fetch", async (req, res) => {
  try {
    const list = Array.isArray((req.body || {}).boxes) ? req.body.boxes.slice(0, 80) : [];
    const out = {};
    for (const b of list) {
      if (!b || !okBox(b.box)) continue;
      const after = Number(b.after) || 0;
      out[b.box] = (await mailList(b.box)).filter((m) => m && m.at > after);
    }
    res.json({ ok: true, boxes: out });
  } catch (e) { console.error("mail/fetch:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
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
  try { const r = await markPaidByHand(req.body?.ref, req.body?.months); if (!r) return res.status(404).json({ ok: false, error: "Unknown reference code" }); res.json(Object.assign({ ok: true }, r)); }
  catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
/* ---- 5. Free access by hand (any country, no payment needed) ----
   Two ways, both from /admin:
   a) type the person's LEDGER-XXXXXX code and choose how long (or forever);
   b) make a GIFT-XXXXXX code, send it to them on WhatsApp, they type it in the app. */
const FOREVER = "2099-12-31";
function adminGuard(req, res) {
  if (!ADMIN_KEY) { res.status(503).json({ ok: false, error: "ADMIN_KEY is not set on the server yet" }); return false; }
  if (!adminOk(req)) { res.status(401).json({ ok: false, error: "Wrong admin key" }); return false; }
  return true;
}
const cleanNote = (n) => String(n || "").replace(/[<>]/g, "").trim().slice(0, 80);
function applyFree(rec, months, forever) {
  const base = rec.renewedUntil && rec.renewedUntil > today() ? rec.renewedUntil : today();
  rec.paid = true; rec.paidAt = today(); rec.free = true;
  rec.renewedUntil = forever ? FOREVER : addDays(base, SUBSCRIPTION_DAYS * Math.min(120, Math.max(1, Math.floor(Number(months) || 1))));
  delete rec.pendingReview;
  return rec;
}
async function noteGrant(ref, note, until, how) {
  const list = ((await docGet("grants")) || []).filter((g) => g.ref !== ref);
  list.unshift({ ref, note, until, how, at: new Date().toISOString() });
  await docPut("grants", list.slice(0, 500));
}
app.post("/api/admin/grant", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try {
    const code = String(req.body?.ref || "").replace(/^LEDGER-/i, "").trim().toUpperCase();
    const rec = code ? await subGetOrCreate(code) : null;
    if (!rec) return res.status(404).json({ ok: false, error: "That doesn't look like a LEDGER- code. It has 6 letters/numbers after LEDGER-, e.g. LEDGER-405BAE." });
    const forever = !!req.body?.forever, note = cleanNote(req.body?.note);
    applyFree(rec, req.body?.months, forever); if (note) rec.note = note;
    await subPut(code, rec);
    await noteGrant(`LEDGER-${code}`, note, rec.renewedUntil, "by hand");
    await logPayment({ result: "free access given by hand" + (forever ? " (forever)" : ""), ref: `LEDGER-${code}`, until: rec.renewedUntil, how: note });
    res.json({ ok: true, ref: `LEDGER-${code}`, renewedUntil: rec.renewedUntil, forever });
  } catch (e) { console.error("admin/grant:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/admin/revoke", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try {
    const code = String(req.body?.ref || "").replace(/^LEDGER-/i, "").trim().toUpperCase();
    const rec = code ? await subGet(code) : null;
    if (!rec) return res.status(404).json({ ok: false, error: "Unknown code" });
    rec.renewedUntil = addDays(today(), -1); rec.free = false;
    await subPut(code, rec);
    await docPut("grants", ((await docGet("grants")) || []).filter((g) => g.ref !== `LEDGER-${code}`));
    await logPayment({ result: "access removed", ref: `LEDGER-${code}` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.get("/api/admin/grants", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try { res.json({ ok: true, grants: (await docGet("grants")) || [], gifts: (await docGet("gifts")) || [] }); }
  catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/admin/gift", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try {
    let code; do { code = "GIFT-" + genRef(); } while (await docGet("gift:" + code));
    const g = { code, months: Math.min(120, Math.max(1, Math.floor(Number(req.body?.months) || 1))), forever: !!req.body?.forever, note: cleanNote(req.body?.note), createdAt: new Date().toISOString(), usedBy: null, usedAt: null };
    await docPut("gift:" + code, g);
    const list = (await docGet("gifts")) || []; list.unshift(g); await docPut("gifts", list.slice(0, 500));
    res.json(Object.assign({ ok: true }, g));
  } catch (e) { console.error("admin/gift:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/admin/gift-delete", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    const g = await docGet("gift:" + code);
    if (g && !g.usedBy) { g.usedBy = "cancelled"; g.usedAt = new Date().toISOString(); await docPut("gift:" + code, g); }
    await docPut("gifts", ((await docGet("gifts")) || []).map((x) => x.code === code && !x.usedBy ? Object.assign({}, x, { usedBy: "cancelled" }) : x));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
// The app sends { ref, code } when someone types a gift code.
const redeemHits = new Map();
app.post("/api/redeem", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "?", now = Date.now();
    const hits = (redeemHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000); hits.push(now); redeemHits.set(ip, hits);
    if (hits.length > 20) return res.status(429).json({ ok: false, error: "Too many tries — wait a few minutes." });
    const ref = String(req.body?.ref || "").replace(/^LEDGER-/i, "").trim().toUpperCase();
    let code = String(req.body?.code || "").trim().toUpperCase().replace(/\s+/g, "");
    if (/^[A-Z0-9]{6}$/.test(code)) code = "GIFT-" + code;
    const rec = ref ? await subGetOrCreate(ref) : null;
    if (!rec) return res.status(404).json({ ok: false, error: "This app has no code yet — connect to the internet and try again." });
    const g = await docGet("gift:" + code);
    if (!g) return res.status(404).json({ ok: false, error: "That access code is not right. Check it and try again." });
    if (g.usedBy && g.usedBy !== `LEDGER-${ref}`) return res.status(409).json({ ok: false, error: g.usedBy === "cancelled" ? "That access code was cancelled." : "That access code was already used on another phone." });
    if (!g.usedBy) {
      applyFree(rec, g.months, g.forever); if (g.note) rec.note = g.note;
      await subPut(ref, rec);
      g.usedBy = `LEDGER-${ref}`; g.usedAt = new Date().toISOString(); await docPut("gift:" + code, g);
      await docPut("gifts", ((await docGet("gifts")) || []).map((x) => x.code === code ? g : x));
      await noteGrant(`LEDGER-${ref}`, g.note, rec.renewedUntil, code);
      await logPayment({ result: "access code used" + (g.forever ? " (forever)" : ""), ref: `LEDGER-${ref}`, how: code + (g.note ? " · " + g.note : ""), until: rec.renewedUntil });
    }
    res.json({ ok: true, renewedUntil: rec.renewedUntil, forever: rec.renewedUntil === FOREVER });
  } catch (e) { console.error("redeem:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ---- 6. Help videos: the owner pastes a Facebook link for each topic on /admin; every app reads them ---- */
const HELP_TOPICS = ["page","intro","start","stock","sale","credit","store","staff","businesses","suppliers","reports"];
app.get("/api/help-videos", async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json({ ok: true, videos: (await docGet("help-videos")) || {} }); }
  catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/admin/help-videos", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try {
    const out = {}, inp = req.body?.videos || {};
    for (const k of HELP_TOPICS) {
      const v = String(inp[k] || "").trim();
      if (!v) continue;
      if (!/^https:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.watch|fb\.com|youtube\.com|youtu\.be|tiktok\.com)\//i.test(v) || v.length > 400) return res.status(400).json({ ok: false, error: `The link for "${k}" must be a Facebook, YouTube or TikTok link starting with https://` });
      out[k] = v;
    }
    await docPut("help-videos", out);
    res.json({ ok: true, videos: out });
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ---- 7. Receipt identity: one phone number and one Gmail belong to ONE business only ----
   Stops someone copying a real supplier's phone/Gmail onto fake receipts.
   The app keeps a secret per business; only the hash is stored here. */
const RID_NS = "rid:";
function ridPhone(v) { const d = String(v || "").replace(/\D/g, ""); return d.length >= 7 && d.length <= 15 ? d.slice(-8) : ""; }
function ridGmail(v) {
  const m = String(v || "").trim().toLowerCase().match(/^([a-z0-9._%+-]{1,64})@(gmail|googlemail)\.com$/);
  if (!m) return "";
  return m[1].split("+")[0].replace(/\./g, "") + "@gmail.com"; // Gmail ignores dots and +tags
}
const ridKey = (kind, norm) => RID_NS + kind + ":" + crypto.createHash("sha256").update(kind + "|" + norm).digest("hex").slice(0, 40);
const ridHash = (secret) => crypto.createHash("sha256").update("ledger-rid|" + secret).digest("hex");
async function ridGet(key) { const v = await kvGet(key); return v ? JSON.parse(v) : null; }
async function ridTake(key, rec) { // returns the owner record that is there after trying
  if (USE_REDIS) { const ok = await redisCmd(["SET", key, JSON.stringify(rec), "NX"]); if (ok) return rec; return ridGet(key); }
  const cur = await ridGet(key); if (cur) return cur; await kvSet(key, JSON.stringify(rec)); return rec;
}
async function ridIndex(add, removeKeys) {
  const list = ((await docGet("receipt-ids")) || []).filter((x) => !removeKeys.includes(x.key));
  if (add) list.unshift(add);
  await docPut("receipt-ids", list.slice(0, 5000));
}
const ridHits = new Map();
function ridTooMany(ip) { const now = Date.now(); const l = (ridHits.get(ip) || []).filter((t) => now - t < 600000); l.push(now); ridHits.set(ip, l); if (ridHits.size > 5000) ridHits.clear(); return l.length > 30; }
app.post("/api/receipt-id/claim", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?";
    if (ridTooMany(ip)) return res.status(429).json({ ok: false, error: "Too many tries — wait a few minutes" });
    const b = req.body || {}, secret = String(b.secret || "");
    if (!/^[a-f0-9]{32,64}$/.test(secret)) return res.status(400).json({ ok: false, error: "Bad request" });
    const phone = ridPhone(b.phone), gmail = ridGmail(b.email);
    if (!phone) return res.status(400).json({ ok: false, field: "phone", error: "Enter one correct phone number." });
    if (!gmail) return res.status(400).json({ ok: false, field: "email", error: "Enter one Gmail address that ends with @gmail.com." });
    const h = ridHash(secret), name = String(b.name || "").slice(0, 80), at = new Date().toISOString();
    const want = [["phone", ridKey("phone", phone)], ["email", ridKey("email", gmail)]];
    for (const [field, key] of want) { const cur = await ridGet(key); if (cur && cur.h !== h) return res.status(409).json({ ok: false, field, error: field === "phone" ? "taken-phone" : "taken-email" }); }
    const got = [];
    for (const [field, key] of want) {
      const rec = { h, name, at, kind: field, show: field === "phone" ? String(b.phone).slice(0, 24) : gmail };
      const owner = await ridTake(key, rec);
      if (owner.h !== h) { for (const k of got) await kvDel(k); return res.status(409).json({ ok: false, field, error: field === "phone" ? "taken-phone" : "taken-email" }); }
      if (owner.name !== name) await kvSet(key, JSON.stringify(Object.assign({}, owner, { name })));
      got.push(key);
    }
    // let go of this business's old phone/Gmail if they changed
    const drop = [];
    for (const [kind, v] of [["phone", ridPhone(b.oldPhone)], ["email", ridGmail(b.oldEmail)]]) {
      if (!v) continue; const k = ridKey(kind, v); if (got.includes(k)) continue;
      const cur = await ridGet(k); if (cur && cur.h === h) { await kvDel(k); drop.push(k); }
    }
    const list = ((await docGet("receipt-ids")) || []).filter((x) => !drop.includes(x.key) && !got.includes(x.key));
    want.forEach(([field, key]) => list.unshift({ key, kind: field, show: field === "phone" ? String(b.phone).slice(0, 24) : gmail, name, at }));
    await docPut("receipt-ids", list.slice(0, 5000));
    res.json({ ok: true });
  } catch (e) { console.error("receipt-id/claim:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.get("/api/admin/receipt-ids", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try { res.json({ ok: true, list: ((await docGet("receipt-ids")) || []).slice(0, 500) }); }
  catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/admin/receipt-id-free", async (req, res) => { // when the real owner complains that someone took their number/Gmail
  if (!adminGuard(req, res)) return;
  try {
    const v = String(req.body?.value || "").trim();
    const key = ridGmail(v) ? ridKey("email", ridGmail(v)) : (ridPhone(v) ? ridKey("phone", ridPhone(v)) : "");
    if (!key) return res.status(400).json({ ok: false, error: "Type a phone number or a Gmail address." });
    const cur = await ridGet(key);
    if (!cur) return res.json({ ok: true, freed: false, msg: "Nobody is using it — it is already free." });
    await kvDel(key); await ridIndex(null, [key]);
    res.json({ ok: true, freed: true, msg: "Freed — it was used by " + (cur.name || "a business") + ". The real owner can now save it in their app." });
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});

/* ---- 8. Help assistant ("Ask for help" in the app) ----
   The AI key stays here on the server (Render setting ANTHROPIC_API_KEY); the app never sees it.
   A Claude key made without a workspace also needs ANTHROPIC_WORKSPACE_ID (the workspace ID shown in the Console).
   Or the free Gemini tier: GEMINI_API_KEY (from aistudio.google.com). Claude is used when both are set.
   Optional settings: ASSISTANT_MODEL (default claude-haiku-5-5), GEMINI_MODEL (default gemini-flash-latest), ASSISTANT_DAILY_LIMIT (default 500 questions a day). */
const HELP_KB = "COMPANY: Tholley Tech. Founder and CEO: Gibrill (based in Monrovia, Liberia). Mission: digital tools for businesses of every size, small and big, across Africa and for Africans in the diaspora who own businesses in Africa. Website: tholleytech.com (The Ledger opens and installs from there).\n\nPRICE OF THE LEDGER: advertised as FREE throughout 2026. The standard subscription has been US$2 (L$400) a month in Liberia and NLe 50 a month in Sierra Leone, paid by Orange Money; 1, 3, 6 or 12 months at once. Prices for 2027 will be announced. Users in other countries arrange access with the team on WhatsApp (they may get an access code). The team can visit shops in the Monrovia area to set the app up in person.\n\nOTHER WORK (in development; no public details, prices or dates \u2014 offer a meeting with Gibrill): payments that connect mobile money, banks and cards across West Africa; a digital deposit/withdrawal slip system for banks; a property information platform for West Africa.\n\nMEETINGS: 45 minutes, by phone, WhatsApp video or in person in Monrovia. Monday to Friday. Times in Monrovia time (GMT).\n\nHOW THE APP IS LAID OUT (new look, version 73 and later): the top bar shows the business name (tap it to switch business), then \ud83d\udd0d search (find any sale or receipt), \ud83d\udd14 alerts and approvals, and ? help. The black-and-gold \ud83d\udcac Help button that opens this assistant is on every screen (bottom right; at the top while a window is open). The bottom bar is Home \u00b7 Sales \u00b7 Sell (black + in the middle) \u00b7 History (sales & stock check: every sale, stock in and out, reports) \u00b7 Stock \u00b7 More. Home shows a black money card (Today / This week / This month: sales, profit, expenses, number of sales, cash vs mobile money), four quick buttons (Expense, Stock in, Credit, Return), a \"Needs attention\" list (low stock, who owes you, drafts, approvals, deliveries, recovery code) and \"Latest sales\". Sell opens a grid of items with a search box (also for new items), \ud83c\udfa4 voice and \ud83d\udcf7 scan, and customer chips at the top (\"\u23f8 Hold \u00b7 Next\" to serve several customers; tap a waiting name to go back). Tap items, then \"Charge\": tap an item to change piece/carton, price or currency; choose Cash / Mobile Money / Credit (and Part payment for wholesale), \"Customer gave\" for change, the customer's name, the date, then \"Complete sale\". There is no separate old sale form any more. More holds everything else in groups: RECORD (New sale, Expense, Add stock, Credit / debt, New item, Add many items, Customer return, Find a receipt, Drafts), MONEY (Credit Book, Expenses, Profit & reports, Sales & stock check, Backup & Restore), BUSINESS (How you sell, My businesses, Suppliers & orders, Staff & staff PIN, Approvals, Stock alerts, Business name/type/money, Business stamp), APP & SAFETY (Country, money & language, Recovery code, Change owner PIN, Your name, Daily prayer, Install app, Switch staff, Lock ledger), HELP (Ask for help, Help videos, Check for updates) and the language buttons. Mobile money agents keep their own bar (Home \u00b7 MoMo \u00b7 + \u00b7 Credit \u00b7 More). On computers the menu stays open on the left.\n\nAPP: The Ledger (live) \u2014 Bookkeeping app for businesses of every size: sales, stock, expenses, Credit Book, staff, several businesses and suppliers. Installed from tholleytech.com. Works without internet. English, French and Arabic. 33 African countries and their money.\n\nSTEP-BY-STEP GUIDES:\nGUIDE: Install The Ledger on your phone\n1. Open tholleytech.com on your phone. On Android use Chrome; on iPhone use Safari.\n2. Android: tap the menu (\u22ee) at the top right, then \u201cInstall app\u201d or \u201cAdd to Home screen\u201d, then \u201cInstall\u201d.\n3. iPhone: tap the Share button (square with an arrow), scroll down, tap \u201cAdd to Home Screen\u201d, then \u201cAdd\u201d.\n4. Open The Ledger from its icon on your home screen. It now works like any app, even without internet.\n5. Already inside the app? Tap More (bottom bar) \u2192 \u201cInstall app on this phone\u201d, or tap \u201cInstall\u201d on the Home card.\nTip: You don't need the Play Store or App Store. If the install option doesn't show, update Chrome or Safari and try again.\n\nGUIDE: First-time setup (language, PIN, business)\n1. Open the app. Pick your language at the top right: EN, FR or \u0639\u0631\u0628\u064a.\n2. Read the three welcome screens (or tap Next), then tap \u201cGet started\u201d.\n3. Create your 4-number PIN, then enter it once more. Write it down somewhere safe \u2014 a forgotten PIN can't be reset.\n4. Type your business name and tap what you sell (Shop, Pharmacy, Food, Fashion, Phones or Other).\n5. Check the country and money shown (picked from your phone). Tap \u201cChange\u201d if it's wrong.\n6. Tap \u201cOpen my ledger\u201d. Your Home screen shows a \u201cGet started\u201d list to guide you.\nTip: Already use The Ledger on another phone? On the PIN screen tap \u201cI already use The Ledger\u201d to restore with a recovery code, a staff setup code, or a backup file.\n\nGUIDE: Change country, money or language\n1. Tap More (bottom bar), then \u201cCountry, money & language\u201d.\n2. Choose your country \u2014 its money is set for you. Pick another money if you price in US dollars.\n3. Choose English, Fran\u00e7ais or \u0627\u0644\u0639\u0631\u0628\u064a\u0629. Arabic turns the app right-to-left.\n4. Tap Save.\n\nGUIDE: Add your goods (stock)\n1. Go to the Stock tab at the bottom.\n2. One item: tap \u201c+ Add\u201d, type the name, cost price, selling price and how many you have, then \u201cSave item\u201d.\n3. Many items at once: tap \u201c\u26a1 Add many items\u201d. Type your list, or take a photo of your written list or invoice and let the app read it.\n4. Check the items it found, fix any number, and save.\n5. Sell in packs? Set the pack name (carton, box, bag) and how many pieces are in one pack.\nTip: Set a low-stock level on each item so the app warns you in \u201c\ud83d\udea8 Stock alerts\u201d before you run out.\n\nGUIDE: Record a sale and share the receipt\n1. Tap \u201cSell\u201d (the black + in the middle of the bottom bar).\n2. Tap each item the customer buys \u2014 tap twice for 2. Use the search box or \ud83d\udcf7 scan to find an item fast. The total shows at the bottom.\n3. Tap \u201cCharge\u201d. Change quantities with \u2212 and + if needed.\n4. Choose how they paid: Cash, Mobile Money or Credit (pay later \u2014 type the customer's name). For cash, tap what the customer gave to see the change.\n5. Tap \u201cComplete sale\u201d. Tap \u201cReceipt\u201d to share it on WhatsApp or download it. Your stock goes down by itself.\n6. Tap an item in the Charge list to sell it by carton or piece, change its price or currency. Change the date, part payment (wholesale) and \u201cCustomer gave\u201d on the Charge screen.\nTip: Serving several customers? Tap \u201c\u23f8 Hold \u00b7 Next\u201d at the top: the first customer waits (tap their name to go back). Type a new item's name in the search box to sell something not in Stock yet.\n\nGUIDE: Serve several customers at once (Hold \u00b7 Next) and Drafts\n1. In Sell, tap the customer chip at the top to type the customer's name (optional).\n2. Tap \u201c\u23f8 Hold \u00b7 Next\u201d: this customer's items wait and a new empty sale opens.\n3. Tap a waiting customer's name at the top to go back to them. After saving a sale, \u201cServe next\u201d opens the next waiting customer.\n4. Closing Sell or locking the app keeps an unfinished sale in Drafts. Open it from Home (Needs attention) or More \u2192 Drafts.\nTip: Credit sales go straight into the Credit Book, so you never forget who owes you.\n\nGUIDE: Record an expense\n1. On Home tap \u201cExpense\u201d (or More \u2192 \u201cExpense\u201d).\n2. Type what it was for (rent, transport, light bill\u2026), the amount and the date.\n3. Tap \u201cSave entry\u201d. Your profit on Home updates by itself.\n\nGUIDE: Credit Book: who owes you, who you owe\n1. On Home tap \u201cCredit\u201d (or More \u2192 \u201cCredit / debt\u201d). To see everyone who owes you, tap More \u2192 \u201cCredit Book\u201d.\n2. Choose the person, the amount and what it is for, then save.\n3. When they pay back, open their name in the Credit Book and record the payment.\n4. Supplier debts from orders appear here too, so you see what you owe each supplier.\n\nGUIDE: Shop and store (warehouse)\n1. Go to Stock and tap \u201c\ud83c\udfec Store\u201d to see what is kept in your store or warehouse.\n2. Move goods to the shop when you need them on the shelf: open the item and tap \u201cMove to shop\u201d.\n3. When goods arrive from a supplier, you choose for each item: shop, store, or split between both.\n\nGUIDE: Set up a staff phone\n1. Tap More (bottom bar), then \u201cStaff & staff PIN\u201d.\n2. Tap \u201c+ Add\u201d, type the staff member's name and give them a staff PIN.\n3. Tap \u201c\ud83d\udd17 Send staff phone setup link\u201d and send it to the staff member on WhatsApp.\n4. The staff member opens the link on their phone, installs The Ledger and enters their staff PIN.\n5. Their sales now reach your phone. You see every receipt, even from abroad. Check \u201c\ud83d\udd14 Approvals\u201d for anything that needs you.\nTip: Staff can sell but can't see your private settings or change your owner PIN.\n\nGUIDE: Protect your records (recovery code and backup)\n1. Tap More (bottom bar), then \u201cRecovery code (if phone is lost)\u201d. Home also reminds you under \u201cNeeds attention\u201d.\n2. Save the code somewhere safe (write it down or keep it in your WhatsApp \u201cMessage yourself\u201d chat). Never share it.\n3. For an extra copy, open \u201c\u2b73 Backup & Restore\u201d and tap \u201cDownload MY backup (private)\u201d.\n4. On a new phone: install The Ledger, tap \u201cI already use The Ledger\u201d, then \u201cI have a recovery code\u201d.\nTip: The Ledger keeps your records on your phone, locked with your PIN. Without the recovery code or a backup, a lost phone means lost records.\n\nGUIDE: Forgot or change your PIN\n1. To change it: More \u2192 \u201cChange owner PIN\u201d, enter the old PIN, then the new one twice.\n2. Forgot it: a PIN can't be reset, because your records are locked with it. Restore on the phone with your recovery code (see \u201cProtect your records\u201d).\n3. No recovery code or backup? Contact Tholley Tech on WhatsApp for advice.\n\nGUIDE: Manage several businesses\n1. Tap More \u2192 \u201cMy businesses\u201d (or tap your business name at the top of the screen).\n2. Tap to add another business, give it a name, and set it up.\n3. Switch between businesses from the same place. Each one keeps its own sales, stock and staff.\n\nGUIDE: Send a budget/order to your supplier\n1. Go to Stock and tap \u201c\ud83d\uded2 What to buy\u201d (or \u201c\ud83d\ude9a Order stock\u201d).\n2. Check the items and amounts. For each item choose the unit (carton, box, bag, piece) and the currency.\n3. Choose the supplier for each item, then tap send for that supplier.\n4. WhatsApp opens with the budget. It shows half of the list; the link opens the full budget for the supplier.\n5. The supplier ticks what they have and sends it back. You are told in the app.\nTip: Suppliers who don't use The Ledger yet can join from the link: they create a PIN and can set up their business later.\n\nGUIDE: Receive goods and approve the count\n1. Open the order when the goods arrive (Suppliers & orders, or the notice on Home).\n2. Count the goods. Fix any number in \u201cArrived\u201d that is different.\n3. Tap \u201c\u2713 Approve the count \u2192\u201d.\n4. Choose where each item goes: \ud83d\uded2 Shop, \ud83c\udfec Store, or \u00bd Split. Then tap \u201c\u2713 Done \u2014 fill my stock\u201d.\n5. What you owe the supplier goes into your Credit Book. Items the supplier will send later stay as a \u201cBalance pending\u201d order.\n\nGUIDE: For suppliers: reply to a budget and send goods\n1. Tap the link the shop sent you. Enter your PIN (new? create one, and set up your business now or later).\n2. For each item tap \u201c\u2713 Have it\u201d or \u201c\u2715 Don't have\u201d. Set how many you can send and your price.\n3. Only part available? Leave \u201cSend the other \u2026 later\u201d ticked and write when (for example \u201cnext week\u201d).\n4. If some prices are in another money, enter today's exchange rate.\n5. Tap \u201cSend to the shop\u201d.\n6. When the goods are ready, tap \u201c\ud83e\uddfe Make receipt & send goods\u201d. The first time, add your business name, one phone number and one Gmail (and your logo if you like).\n7. Choose how the shop pays (credit, cash or mobile money) and tap \u201c\ud83d\ude9a Record sale & send goods\u201d. The sale goes into your books and the shop gets your receipt.\nTip: Your phone number and Gmail are locked to your business, so nobody else can put them on a receipt.\n\nGUIDE: Receipts, business stamp and reports\n1. Add your business stamp: More \u2192 \u201cBusiness stamp (receipts)\u201d.\n2. Find any old receipt: tap \ud83d\udd0d (top of the screen) or More \u2192 \u201cFind a receipt\u201d, then type the item, customer, receipt number or amount.\n3. Reports: More \u2192 \u201cProfit & reports\u201d, or History on the bottom bar, and tap \u201c\u2934 Share report\u201d or \u201c\ud83d\udcc4 Share PDF\u201d.\n\nGUIDE: Pay or renew your subscription\n1. The Ledger is free throughout 2026. When payment is needed, tap \u201cRenew now\u201d on Home.\n2. Liberia and Sierra Leone: pay by Orange Money to the number shown, then tap \u201cSend code on WhatsApp\u201d and \u201cCheck payment now\u201d. The app unlocks when the payment is confirmed.\n3. Outside Liberia and Sierra Leone: tap \u201cMessage us on WhatsApp\u201d to arrange payment.\n4. Got an access code from Tholley Tech? Tap \u201cHave an access code?\u201d and type it.\n\nGUIDE: Help videos and support\n1. Tap More \u2192 \u201cHelp videos\u201d to watch short how-to videos on Facebook.\n2. The first time you open a part of the app, a help card offers the video for that part.\n3. Still stuck? Tap the black \ud83d\udcac Help button (on every screen) or the ? at the top, message Tholley Tech on WhatsApp, or book a meeting.\n\nGUIDE: Customer returned goods (refund or exchange)\n1. On Home tap \u201cReturn\u201d (or More \u2192 \u201cCustomer return\u201d, or in Sales tap \u201c\u21a9 Returns\u201d).\n2. Find the sale: type what they bought (for example rice), the customer's name, the receipt number or the amount, then choose when they bought it (last 7 days, last 2 weeks, last month\u2026). The item you typed is highlighted in each sale.\n3. Tap \u201c\u21a9 Return from this sale\u201d, then choose how many of each item came back.\n4. Pick why: Customer changed mind, Wrong item, or the goods are spoilt (tick it so spoilt goods are not put back on the shelf).\n5. Choose what you do for the customer: Give the money back, Exchange for something else, or Take it off what they owe.\n6. Tap \u201cSave return\u201d. Good items go back into stock and the money comes off your sales and profit.\nTip: Staff can record a return; the owner sees it. For an exchange, record the new item as a normal sale.\n\nGUIDE: Customer returns goods without a receipt\n1. On Home tap \u201cReturn\u201d, then at the bottom tap \u201cCan't find it? The customer has no receipt\u201d.\n2. Type the item, how many came back, and when they bought it (this week, 1\u20132 weeks ago\u2026).\n3. The app shows the sales of that item from that time. If one of them is the customer's, tap \u201cThis one\u201d: it is safer, because the price and date come from the real sale.\n4. If none fits, check the price for one (the app fills in the last price it was sold at), choose why and what you do, then tap \u201cSave return\u201d.\n5. The return is saved marked \u201cNo receipt\u201d. See every return, with the sale it came from, in Sales \u2192 \u201c\u21a9 Returns\u201d \u2192 \u201cSee all returns\u201d.\nTip: Staff can't give back more than the item was ever sold for. The owner can tap \u201cNo receipt only\u201d in the returns list to check these.\n\nGUIDE: Find an old sale or receipt quickly\n1. Tap \ud83d\udd0d at the top of the screen, or in Sales tap \u201c\ud83d\udd0e Find a sale\u201d.\n2. Type an item, a customer's name, the receipt number or the amount. Tap an item suggestion to see only sales with that item.\n3. Choose the time: last 7 days, 2 weeks, a month, 3 months or any time.\n4. Tap \u201cOpen receipt\u201d to see, share or print it again, or \u201c\u21a9 Return\u201d if goods came back.\n\nGUIDE: Retail, wholesale or both: set how you sell\n1. Tap More (bottom bar), then \u201cHow you sell\u201d.\n2. Choose Retail (pieces to walk-in customers), Wholesale (cartons, bags and bales to shops and traders) or Retail & Wholesale (both, from the same stock).\n3. Tap \u201cSave\u201d. Retail works exactly as before.\n4. Wholesale or both: next set your wholesale and bulk prices, and your traders' credit limits (buttons on the same screen).\nTip: With Retail & Wholesale, each sale has a switch at the top: \u201cShop price\u201d or \u201cWholesale\u201d. Picking a trader who has a credit limit switches to Wholesale by itself.\n\nGUIDE: Set wholesale prices and bulk prices (10+ cartons\u2026)\n1. More \u2192 \u201cHow you sell\u201d \u2192 \u201c\ud83c\udff7 Wholesale & bulk prices\u201d (or Stock \u2192 Manage items \u2192 \u201cWholesale & bulk prices\u201d).\n2. Tap the item. Type the wholesale price for one carton (or one bag, bale\u2026). Items sold in cartons need the carton size set in Stock first (1 carton = 40 pieces, for example).\n3. Under \u201cBulk prices\u201d type a quantity and its lower price, for example 10 cartons or more \u2192 L$ 1,050 each. Tap \u201c+ Add a bulk price\u201d for another step (50 or more\u2026).\n4. Tap \u201cSave\u201d. On a wholesale sale the price fills in by itself and drops to the bulk price when the quantity reaches it.\nTip: If you type your own price on a sale, the app keeps it and doesn't change it.\n\nGUIDE: Traders and credit limits\n1. More \u2192 \u201cHow you sell\u201d \u2192 \u201c\ud83d\udc65 Traders & credit limits\u201d.\n2. Tap \u201cSet limit\u201d next to a trader, or type a new trader's name and limit at the bottom and tap \u201c+ Add\u201d.\n3. On a sale, type the trader's name: the app shows what they owe and their limit, and how much they will owe after this sale.\n4. If a credit or part-payment sale goes over the limit, staff can't save it; the owner sees a warning and taps Save again to allow it.\n\nGUIDE: Part payment, pay-by date, invoices and deliveries (wholesale)\n1. On a wholesale sale choose \u201cPaid by\u201d \u2192 \u201cPart payment\u201d, type the customer's name and how much they paid now. The balance goes into the Credit Book by itself.\n2. For Credit or Part payment, set the \u201cPay by\u201d date (two weeks ahead is filled in).\n3. Tick \u201cWe deliver this order\u201d if you deliver it.\n4. Save: the receipt becomes an INVOICE showing paid now, balance and pay-by date, with a \u201cPART PAID\u201d stamp.\n5. On the invoice tap Packed \u2192 On the truck \u2192 Delivered as the order moves. Home shows \u201cTo deliver\u201d; tap it to move each order along.\n\nGUIDE: Serve several customers at once (Hold \u00b7 Next customer) and drafts\n1. While recording a sale, tap \u201c\u23f8 Hold \u00b7 Next customer\u201d to keep it waiting and start a new one.\n2. Each waiting customer gets their own tab \u2014 tap it to finish their sale.\n3. A sale you start but don't save is kept in \u201c\ud83d\udcdd Draft sales\u201d. Open it any time to Continue, Save sale or Delete.\n\nGUIDE: Sell faster: item numbers, barcode scan and voice\n1. In \u201cRecord a sale\u201d, type the item's number (for example 014) or part of its name.\n2. Or tap \u201c\ud83d\udcf7 Scan\u201d and point the camera at the barcode.\n3. Or tap \u201c\ud83c\udfa4 Speak it\u201d and say the item and how many.\n4. Use \u201c+ Add another product to this sale\u201d for more items, then \u201cSave sale\u201d.\n\nGUIDE: Sale details: quantity, price, customer, change, date\n1. In \u201cRecord a sale\u201d, set Quantity with \u2212 and +, and check the Price per unit (you can change it for this sale).\n2. Selling by carton, box or piece? Choose it under \u201cSelling by\u201d.\n3. Add a Customer name if you want it on the receipt.\n4. Choose Paid by (Cash, Mobile Money, Credit\u2026). For cash, type what the customer gave to see the change.\n5. You can change the Date at the top for a sale made earlier, then tap \u201cSave sale\u201d.\n\nGUIDE: Add new stock to an item you already have (restock)\n1. Go to Stock and tap the item, then \u201c+ Add stock\u201d (or + \u2192 \u201c\ud83d\udce6 Add stock to\u2026\u201d and search the item).\n2. Type how many came in and the cost if it changed, then save.\n3. Goods kept in the store? Add them to the store, then use \u201c\ud83d\ude9a Move to shop\u201d when you bring them out.\n\nGUIDE: Remove damaged, expired, lost or used stock\n1. Go to Stock, tap the item and choose \u201c\u2212 Remove stock\u201d. Use this for stock that leaves without a sale.\n2. Type how much to remove and pick the reason (damaged, expired, lost, used\u2026). Add a note if you like.\n3. Tap \u201cRemove from stock\u201d. The owner is told about every removal made by staff.\n\nGUIDE: Count your stock and find what is missing\n1. Go to Stock, tap the item and choose \u201cEdit / count\u201d, then type how many are really on the shelf.\n2. The first time a new item is sold, the app asks \u201c\ud83d\udce6 How many do you have left?\u201d \u2014 type the number and tap \u201cSave stock\u201d.\n3. Open HISTORY to see everything sold, what is left of each product, and whether anything is MISSING since the last count.\n4. For the store, use \u201c\ud83c\udfec Count the store\u201d.\n\nGUIDE: Change prices or remove an item\n1. Go to Stock and tap the item, or open \u201cItems & prices\u201d / \u201cManage items\u201d.\n2. Change the selling price, cost price, pack size or low-stock level, then save.\n3. Only the owner can change prices or remove items.\n\nGUIDE: Fix a mistake: delete or correct an entry\n1. Open Sales or History (bottom bar), or the list where the entry is, and tap the \u2715 next to the wrong sale, expense or entry.\n2. Owner: confirm \u201cDelete it\u201d. Then record it again correctly.\n3. Staff: the request goes to the owner, who approves it in \u201c\ud83d\udd14 Approvals\u201d.\n4. Goods brought back by a customer are a return, not a delete \u2014 use \u201c\u21a9 Customer returned goods\u201d on the receipt.\n\nGUIDE: Approvals: staff requests the owner must check\n1. Tap the \ud83d\udd14 bell at the top (or More \u2192 \u201cApprovals\u201d, or the item under \u201cNeeds attention\u201d on Home).\n2. You will see new staff asking for access and staff asking to delete an entry.\n3. Tap Approve or Decline for each one.\n\nGUIDE: Receipt status, design and notes\n1. After a sale the receipt opens (or open one with + \u2192 \u201cFind a receipt\u201d).\n2. Choose the status stamp: Paid, Paid & delivered, Paid not delivered, Delivered, Part paid (balance due), Not paid (credit), Received or Quotation.\n3. Choose a design: Classic, Elegant, Modern or Till slip, and add a note if you need one.\n4. Share it on WhatsApp or as a PDF. Add your business stamp in More \u2192 \u201cBusiness stamp (receipts)\u201d.\n\nGUIDE: Understand Home: sales, profit, real profit, yesterday vs today\n1. Home shows today's sales, product profit (selling price minus cost) and expenses.\n2. Real profit = product profit minus expenses. You are warned if expenses eat into your business money.\n3. \u201cYesterday vs today\u201d compares with the same time yesterday.\n4. For any period, open History (bottom bar) or More \u2192 \u201cProfit & reports\u201d and share the report or PDF.\n\nGUIDE: Lock the app, your name, and staff vs owner PIN\n1. Lock the app any time: More \u2192 \u201cLock ledger\u201d. It opens again with your PIN.\n2. Change the name used in greetings: \u201c\u270e Your name (for greetings)\u201d.\n3. On a staff phone only the staff PIN works \u2014 the owner PIN shows \u201cIncorrect PIN\u201d there, by design.\n\nGUIDE: Pay for several months at once\n1. Tap \u201cRenew now\u201d on Home (paying early keeps the days you have left).\n2. Choose 1, 3, 6 or 12 months.\n3. Pay by Orange Money to the number shown for your country (Liberia or Sierra Leone), tap \u201cSend code on WhatsApp\u201d, and the app opens by itself once the payment is confirmed.\n\nGUIDE: Mobile money agents: record transactions\n1. Choose the business type \u201cMobile money agent\u201d when you set up the business.\n2. Then use the + button \u2192 \u201cRecord a mobile money transaction\u201d for each cash-in, cash-out or transfer.\n\nFEATURES OF THE LEDGER (newest first, from the app's \"What's new\"):\n- \ud83d\udccb History (sales & stock check) is back on the bottom bar, and the \ud83d\udcac Help button is on every screen again \u2014 even while selling and in pop-up windows\n- \ud83d\uded2 One Sell screen for everything: serve several customers at once (\u23f8 Hold \u00b7 Next), sell by piece or carton, change a price, the currency or the date, new items, part payment, cash change and drafts \u2014 all in the new look. The old sale form is gone\n- \u2728 New look: Home shows today\u2019s money first (sales, profit, cash and mobile money), with quick buttons and one \u201cNeeds attention\u201d list. Tap Sell in the middle of the bottom bar: tap items, then Charge \u2014 done in seconds. Every setting is now grouped in More\n- \ud83c\udfec Retail, wholesale or both: tell the app how you sell (More \u2192 How you sell). Wholesale adds carton prices with bulk prices, traders with credit limits, part payment with a pay-by date, invoices and delivery steps. Both adds a Shop price \u00b7 Wholesale switch on each sale\n- \u21a9 Customer returns are easy to track: find the sale by item, customer, receipt number or amount \u2014 even weeks later. No receipt? The app suggests the likely sale, or saves the return marked \u201cNo receipt\u201d. See every return in one list\n- \ud83d\udcd6 Help now works even offline: step-by-step guides for every part of the app, plus a form to book a meeting with the Tholley Tech team\n- \ud83d\udcac New: Ask for help \u2014 our assistant answers set-up and how-to questions any time, and can book a meeting with the Tholley Tech team. tap the \ud83d\udcac Help button on any screen\n- \ud83c\udfec After you approve goods from a supplier, choose for each item: shop, store, or split between both\n- \ud83d\udd12 A phone number and Gmail can now be on the receipts of ONE business only \u2014 nobody can copy a supplier\u2019s contacts onto fake receipts\n- \ud83d\udcd2 Suppliers: sending goods now records the sale in your own books (cash, mobile money or credit) together with the delivery receipt\n- \u23f3 Suppliers can send part now and the balance later \u2014 the rest waits as a pending balance order. \ud83e\uddfe Receipts now carry each supplier\u2019s own logo, one phone number, one Gmail and a message\n- \ud83e\uddfe Budgets to suppliers: WhatsApp shows half the list and the link opens the rest. Suppliers tick what they have, set an exchange rate for foreign money, and send a delivery receipt with the goods\n- \u2728 A fresh new look when you open The Ledger: a welcome tour, a cleaner PIN screen, quick business setup, and a \u201cGet started\u201d checklist on Home. The daily prayer now opens with one tap\n- \ud83c\udfac Help videos: the first time you open each part of the app, a card offers a 1-minute video showing how it works. All videos: Menu \u2192 Settings & more \u2192 Help videos\n- \ud83c\udf0d The Ledger now speaks English, Fran\u00e7ais and \u0627\u0644\u0639\u0631\u0628\u064a\u0629, and works in 33 African countries with their own money and mobile money networks. Menu \u2192 Settings & more \u2192 Country, money & language\n- \ud83d\ude9a Easier ordering: choose carton, box, pack or piece for each item, with its own price and currency. Send the order on WhatsApp \u2014 your supplier taps the link and is connected, even if they never used The Ledger\n- \u2630 Tidier menu: Lock, Staff, Suppliers, Backup and the other settings are now inside one \u201c\u2699\ufe0f Settings & more\u201d button\n- \u2728 New look: deep black, ash, white and yellow, with clean modern lettering that is easier to read\n- \ud83d\ude9a Suppliers & orders: Stock \u2192 \u201cWhat to buy\u201d \u2192 \ud83d\ude9a Order from suppliers. One order per supplier, filled from your low stock. Suppliers on The Ledger confirm in their app; when the goods arrive you count them and tap Approve \u2014 your stock fills by itself\n- \ud83c\udfea Many businesses on one phone: Home \u2192 \u201cMy businesses\u201d \u2192 \uff0b Add another business. Each keeps its own records \u2014 one owner PIN opens them all, and you see today's totals for every business together\n- \u21a9 Returns: open the receipt \u2192 \u201cCustomer returned something\u201d. Stock goes back and the money comes off sales and profit\n- \ud83c\udfec Store & shop: keep store goods separate \u2014 \ud83d\ude9a Move to shop when you bring them out\n- \ud83d\udd22 Item numbers & barcodes: type 014 or tap \ud83d\udcf7 Scan when selling\n- \u23f8 Hold \u00b7 Next customer: serve many customers at once, each in their own tab\n- \ud83d\udcf7 Photos and scans: take a photo of an invoice or stock list in \u26a1 Add many items \u2014 The Ledger reads it and puts the items in Stock\n- \ud83c\uddf8\ud83c\uddf1 Sierra Leone: renew for NLe 50 a month on the Sierra Leone number\n- \ud83d\udcc4 Read a PDF: choose a supplier invoice or stock list in \u26a1 Add many items \u2014 The Ledger finds every item, how many and the price, and puts them in Stock for you\n- Set up your shop fast: \u26a1 Add many items at once (one per line), and the app asks how many are left the first time a new item is sold\n- New HISTORY button: everything sold, what is left of each product, and whether anything is MISSING after you count the shelf\n- Fits every screen: phone, tablet and computer \u2014 a full menu on the left on big screens\n- Drafts: a sale you start but don\u2019t save is kept in Drafts \u2014 finish it any time\n- Good morning! The Ledger greets you by name, with a daily prayer for your business\n- Yesterday vs today on the Dashboard \u2014 and how you are doing compared with yesterday at this time\n- Real profit: expenses are paid from product profit first; you are warned if they eat into your business money\n- New bottom bar like The Ledger 2.0: Home \u00b7 Sales \u00b7 \uff0b \u00b7 Stock \u00b7 More \u2014 tap the gold \uff0b to record anything\n- Receipts: choose PAID, DELIVERED, PAID BUT NOT DELIVERED, PART PAID and more \u2014 on the stamp and as a coloured band\n- 4 receipt designs: Classic, Elegant, Modern and Till slip \u2014 plus a note on any receipt\n- Works on older phones and tablets (old Chrome versions)\n- Staff phones open only with the staff PIN \u2014 the owner PIN shows \u201cIncorrect PIN\u201d there\n- Setup link on a phone that already had The Ledger: it now opens the owner's business with the staff PIN\n- Pay for 1, 3, 6 or 12 months at once\n- Paying the fee: pay by Orange Money, tap \u201cSend code on WhatsApp\u201d, and the app opens by itself once your payment is confirmed\n- \u201cRenew now\u201d on the Dashboard \u2014 paying early keeps your remaining days\n- Holds 100,000+ sales per business\n- Long lists show 200 at a time \u2014 tap \u201cShow more\u201d for the rest";
const HELP_RULES = `You are "Tholley Assistant", the friendly help assistant inside The Ledger app by Tholley Tech. You know the app well: use the guides, the app layout and the features list below to answer ANY question about The Ledger, including ones no single guide covers. Work out the right steps by combining what the guides and features say (for example a return, a refund, a damaged item, a wrong sale, a price change, a staff problem). Answer directly and confidently; never say "there is no guide" or "I am not sure how" when the information below covers it.
Only if the app really has no such feature, say so in one sentence, suggest the closest thing the app can do, and offer to book a meeting or pass the idea to the team. Never invent buttons, prices, discounts, dates, phone numbers, partners or features that are not below.
Write for busy business owners on a phone: short, warm, clear, plain words, no jargon. Reply in the language the person writes in (English, French or Arabic). For a how-to question give numbered steps with the exact button names, adapted to their situation (Android or iPhone, owner or staff, shop or supplier), then one short line asking if it worked. Otherwise answer in 2-5 sentences. No Markdown headings, tables or ** bold.
If a question is unclear, give the most likely answer and ask one short question to check.
Tools: to book a meeting ask for full name, business name, ONE phone number, country and the topic, call get_free_slots, offer 2-3 times, and call book_meeting only after they choose. For feedback ask a rating from 1 to 5 and the comment, then call save_feedback. If they want a call from the team, take name, one phone number and the reason, then call request_call.
Never ask for or accept PINs, recovery codes, passwords or card numbers; if someone shares one, tell them to keep it private.`;
const HELP_TOOLS = [
  { name: "get_free_slots", description: "Free 45-minute meeting times for the next working days, as 'YYYY-MM-DD HH:MM' in Monrovia time (GMT).", input_schema: { type: "object", properties: {} } },
  { name: "book_meeting", description: "Book a meeting with Gibrill after the person chose a time from get_free_slots.", input_schema: { type: "object", properties: { name: { type: "string" }, business: { type: "string" }, phone: { type: "string" }, country: { type: "string" }, topic: { type: "string" }, mode: { type: "string", description: "phone, WhatsApp video or in person" }, slot: { type: "string" } }, required: ["name", "phone", "slot"] } },
  { name: "save_feedback", description: "Save feedback about The Ledger or Tholley Tech.", input_schema: { type: "object", properties: { rating: { type: "number" }, message: { type: "string" }, name: { type: "string" }, product: { type: "string" } }, required: ["rating", "message"] } },
  { name: "request_call", description: "Ask the Tholley Tech team to phone this person.", input_schema: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, reason: { type: "string" } }, required: ["name", "phone"] } }
];
const HELP_SLOTS = ["10:00", "11:30", "14:00", "15:30"];
async function helpFreeSlots() {
  const taken = new Set(((await docGet("assistant-meetings")) || []).map((m) => m.slot));
  const out = [], now = new Date();
  for (let i = 1; out.length < 16 && i < 15; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i)), wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const t of HELP_SLOTS) { const s = d.toISOString().slice(0, 10) + " " + t; if (!taken.has(s)) out.push(s); }
  }
  return out;
}
const hs = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
async function helpRunTool(name, x, ctx, actions) {
  if (name === "get_free_slots") return { slots: (await helpFreeSlots()).slice(0, 12) };
  if (name === "book_meeting") {
    const slot = hs(x.slot, 16), phone = hs(x.phone, 24);
    if (!(await helpFreeSlots()).includes(slot)) return { error: "That time is not free. Call get_free_slots again." };
    if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) return { error: "Ask for one valid phone number." };
    const rec = { id: crypto.randomBytes(6).toString("hex"), name: hs(x.name, 80), business: hs(x.business, 80), phone, country: hs(x.country || ctx.country, 40), topic: hs(x.topic, 200), mode: hs(x.mode, 30), slot, createdAt: new Date().toISOString(), lang: ctx.lang };
    const list = (await docGet("assistant-meetings")) || []; list.unshift(rec); await docPut("assistant-meetings", list.slice(0, 1000));
    actions.push({ type: "meeting", slot }); return { booked: true, slot };
  }
  if (name === "save_feedback") {
    const rec = { id: crypto.randomBytes(6).toString("hex"), rating: Math.max(1, Math.min(5, Math.round(Number(x.rating) || 0))), message: hs(x.message, 800), name: hs(x.name, 80), product: hs(x.product || "The Ledger", 60), country: ctx.country, createdAt: new Date().toISOString() };
    const list = (await docGet("assistant-feedback")) || []; list.unshift(rec); await docPut("assistant-feedback", list.slice(0, 2000));
    actions.push({ type: "feedback", rating: rec.rating }); return { saved: true };
  }
  if (name === "request_call") {
    const phone = hs(x.phone, 24);
    if (!/^\+?[\d\s()-]{7,20}$/.test(phone)) return { error: "Ask for one valid phone number." };
    const rec = { id: crypto.randomBytes(6).toString("hex"), name: hs(x.name, 80), phone, reason: hs(x.reason, 200), country: ctx.country, createdAt: new Date().toISOString() };
    const list = (await docGet("assistant-calls")) || []; list.unshift(rec); await docPut("assistant-calls", list.slice(0, 1000));
    actions.push({ type: "call" }); return { logged: true };
  }
  return { error: "Unknown tool" };
}
const helpHits = new Map();
function helpTooMany(ip) { const now = Date.now(); const l = (helpHits.get(ip) || []).filter((t) => now - t < 600000); l.push(now); helpHits.set(ip, l); if (helpHits.size > 5000) helpHits.clear(); return l.length > 25; }

/* the two AI services the assistant can use: Claude (paid, ANTHROPIC_API_KEY) or Gemini (free tier, GEMINI_API_KEY) */
async function helpAskClaude(key, system, msgs, ctx, actions, emit) {
  let reply = "";
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  for (let round = 0; round < 5; round++) {
    const r = await fetch(base + "/v1/messages", { method: "POST", headers: Object.assign({ "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      body: JSON.stringify({ model: process.env.ASSISTANT_MODEL || "claude-haiku-5-5", max_tokens: 900, system, tools: HELP_TOOLS, messages: msgs }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("assistant: Claude error", r.status, j && j.error && j.error.type); return null; }
    const blocks = Array.isArray(j.content) ? j.content : [];
    const text = blocks.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
    if (j.stop_reason !== "tool_use") { reply = text; if (emit && text) emit(text); break; }
    msgs.push({ role: "assistant", content: blocks });
    const results = [];
    for (const t of blocks.filter((x) => x.type === "tool_use")) {
      let out; try { out = await helpRunTool(t.name, t.input || {}, ctx, actions); } catch (e) { out = { error: "Could not save — try again." }; }
      results.push({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(out) });
    }
    msgs.push({ role: "user", content: results });
    if (round === 4) reply = text;
  }
  return reply;
}
/* Gemini: answers stream back word by word; "thinking" is switched off so the first words come fast */
let geminiNoThinkingCfg = true;
async function geminiStreamOnce(base, model, key, body, onText) {
  const r = await fetch(base + "/v1beta/models/" + encodeURIComponent(model) + ":streamGenerateContent?alt=sse", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return { status: r.status, err: (j && j.error && (j.error.status || j.error.message)) || "error" }; }
  const parts = []; let buf = "";
  const take = (line) => {
    if (!line.startsWith("data:")) return;
    let j; try { j = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
    const ps = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    for (const p of ps) { parts.push(p); if (typeof p.text === "string" && !p.thought && p.text) onText(p.text); }
  };
  const feed = (txt) => { buf += txt; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); take(line); } };
  if (r.body && typeof r.body.getReader === "function") {
    const rd = r.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await rd.read(); if (done) break; feed(dec.decode(value, { stream: true })); }
  } else {
    await new Promise((resolve, reject) => {
      r.body.on("data", (c) => feed(c.toString("utf8")));
      r.body.on("end", resolve);
      r.body.on("error", reject);
    });
  }
  if (buf) take(buf.replace(/\r$/, ""));
  return { parts };
}
async function helpAskGemini(key, system, msgs, ctx, actions, emit) {
  const base = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const models = [process.env.GEMINI_MODEL || "gemini-flash-latest", "gemini-flash-lite-latest"];
  const decls = HELP_TOOLS.map((t) => { const d = { name: t.name, description: t.description }; if (t.input_schema && Object.keys(t.input_schema.properties || {}).length) d.parameters = t.input_schema; return d; });
  const contents = msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  let reply = "";
  for (let round = 0; round < 5; round++) {
    let res = null;
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const gc = { maxOutputTokens: 1200, temperature: 0.3 };
        if (geminiNoThinkingCfg) gc.thinkingConfig = { thinkingBudget: 0 };
        let text = "";
        res = await geminiStreamOnce(base, model, key, { systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: decls }], generationConfig: gc }, (d) => { text += d; reply += d; if (emit) emit(d); });
        if (res.parts) break;
        if (res.status === 400 && geminiNoThinkingCfg) { geminiNoThinkingCfg = false; continue; } // this model doesn't accept the setting: try again without it
        break;
      }
      if (res.parts) break;
      console.error("assistant: Gemini error", model, res.status, res.err);
      if (!(res.status === 429 || res.status === 404 || res.status >= 500)) break; // busy, missing or down: try the lighter model
    }
    if (!res || !res.parts) return res && res.status === 429 && !reply ? "The assistant is very busy right now. Please try again in a minute." : (reply || null);
    const calls = res.parts.filter((x) => x.functionCall);
    if (!calls.length) break;
    contents.push({ role: "model", parts: res.parts });
    const responses = [];
    for (const c of calls) {
      let out; try { out = await helpRunTool(c.functionCall.name, c.functionCall.args || {}, ctx, actions); } catch (e) { out = { error: "Could not save — try again." }; }
      responses.push({ functionResponse: { name: c.functionCall.name, response: out } });
    }
    contents.push({ role: "user", parts: responses });
    if (reply && !/\s$/.test(reply)) { reply += "\n"; if (emit) emit("\n"); }
  }
  return reply.trim();
}
/* no-AI booking: the app's "Book a meeting" form */
app.get("/api/assistant/slots", async (req, res) => {
  try { res.json({ ok: true, slots: (await helpFreeSlots()).slice(0, 12) }); } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/assistant/meeting", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?";
    if (helpTooMany(ip)) return res.status(429).json({ ok: false, error: "too-many" });
    const b = req.body || {}, actions = [];
    if (!hs(b.name, 80)) return res.status(400).json({ ok: false, error: "Enter your name." });
    const out = await helpRunTool("book_meeting", b, { lang: hs(b.lang, 5), country: hs(b.country, 40) }, actions);
    if (out.error) return res.status(400).json({ ok: false, error: out.error });
    res.json({ ok: true, slot: out.slot });
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
});
app.post("/api/assistant", async (req, res) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY, gkey = process.env.GEMINI_API_KEY;
    if (!key && !gkey) return res.status(503).json({ ok: false, error: "not-configured" });
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?";
    if (helpTooMany(ip)) return res.status(429).json({ ok: false, error: "too-many" });
    const day = new Date().toISOString().slice(0, 10), countKey = "assistant-count:" + day;
    const used = Number(await kvGet(countKey)) || 0, cap = Number(process.env.ASSISTANT_DAILY_LIMIT) || 500;
    if (used >= cap) return res.status(429).json({ ok: false, error: "daily-limit" });
    const b = req.body || {};
    let msgs = Array.isArray(b.messages) ? b.messages : [];
    msgs = msgs.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })).slice(-16);
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ ok: false, error: "Bad request" });
    const c = b.context || {};
    const ctx = { lang: hs(c.lang, 5), country: hs(c.country, 40), currency: hs(c.currency, 6), role: hs(c.role, 12), app: hs(c.app, 30) };
    await kvSet(countKey, String(used + 1));
    const system = HELP_RULES + `\n\nABOUT THIS PERSON (from their app): language ${ctx.lang || "en"}; country ${ctx.country || "unknown"}; money ${ctx.currency || "unknown"}; signed in as ${ctx.role || "unknown"}; app version ${ctx.app || "unknown"}.\n\nFACTS AND GUIDES:\n` + HELP_KB;
    const actions = [];
    if (b.stream === true) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      const line = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch (e) {} };
      line({ start: true });
      let reply = null;
      try { reply = key ? await helpAskClaude(key, system, msgs, ctx, actions, (d) => line({ d })) : await helpAskGemini(gkey, system, msgs, ctx, actions, (d) => line({ d })); }
      catch (e) { console.error("assistant stream:", e.message); }
      if (reply === null) line({ error: "ai-error" });
      else line({ done: true, reply: String(reply).replace(/\*\*(.*?)\*\*/g, "$1"), actions });
      return res.end();
    }
    const reply = key ? await helpAskClaude(key, system, msgs, ctx, actions) : await helpAskGemini(gkey, system, msgs, ctx, actions);
    if (reply === null) return res.status(502).json({ ok: false, error: "ai-error" });
    res.json({ ok: true, reply: reply.replace(/\*\*(.*?)\*\*/g, "$1") || "Sorry, I couldn't answer that. Please try again.", actions });
  } catch (e) { console.error("assistant:", e.message); res.status(500).json({ ok: false, error: "Server error" }); }
});
app.get("/api/admin/assistant", async (req, res) => {
  if (!adminGuard(req, res)) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    res.json({ ok: true, configured: !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY), ai: process.env.ANTHROPIC_API_KEY ? "Claude" : (process.env.GEMINI_API_KEY ? "Gemini (free tier)" : ""), today: Number(await kvGet("assistant-count:" + day)) || 0, limit: Number(process.env.ASSISTANT_DAILY_LIMIT) || 500,
      meetings: ((await docGet("assistant-meetings")) || []).slice(0, 200), feedback: ((await docGet("assistant-feedback")) || []).slice(0, 200), calls: ((await docGet("assistant-calls")) || []).slice(0, 200) });
  } catch (e) { res.status(500).json({ ok: false, error: "Server error" }); }
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
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px;"><input id="mp-ref" placeholder="LEDGER-XXXXXX" style="flex:1;min-width:170px"><select id="mp-months" style="padding:8px;border:1px solid var(--line);border-radius:6px;font-size:14px"><option value="1">1 month</option><option value="2">2 months</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option></select><button id="mp-go" style="white-space:nowrap">Unlock by hand</button></div>
      <div class="err" id="mp-msg"></div>
      <div style="overflow-x:auto"><table id="pay"></table></div></div>
    <div class="card"><b>💬 Help assistant</b><p class="muted" id="as-status">Loading…</p>
      <div style="font-size:13px"><b>Meetings booked</b><div id="as-meet" class="muted" style="max-height:220px;overflow:auto"></div>
      <b style="display:block;margin-top:8px">Call requests</b><div id="as-calls" class="muted" style="max-height:160px;overflow:auto"></div>
      <b style="display:block;margin-top:8px">Feedback</b><div id="as-fb" class="muted" style="max-height:220px;overflow:auto"></div></div></div>
    <div class="card"><b>🧾 Receipt phone numbers &amp; Gmails</b><p class="muted">Each phone number and Gmail can be on the receipts of ONE business only. If a real supplier says someone else took their number or Gmail, type it here and free it.</p>
      <input id="rid-v" placeholder="Phone number or Gmail" style="width:100%"> <button id="rid-free" style="margin-top:8px">Free it</button> <span class="muted" id="rid-msg"></span>
      <div id="rid-list" class="muted" style="margin-top:10px;font-size:13px;max-height:260px;overflow:auto"></div></div>
    <div class="card"><b>🎬 Help videos in the app</b><p class="muted">Paste the Facebook link of each video. The first time someone opens that part of the app, they get a "Watch how it works" card that opens the video on your page. Leave a box empty until its video is ready.</p>
      <div id="hv-rows" style="display:grid;gap:8px;margin-top:8px"></div>
      <button id="hv-save" style="margin-top:10px">Save video links</button> <span class="muted" id="hv-msg"></span></div>
    <div class="card"><b>🎁 Free access — any country, no payment</b><p class="muted">For you, your team, friends, or people abroad (USA, China…) who can't pay by Orange Money.</p>
      <p style="margin:12px 0 4px"><b>A) They send you their code</b> <span class="muted">(shown in their app: Renew screen, LEDGER-XXXXXX)</span></p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;"><input id="gr-ref" placeholder="LEDGER-XXXXXX" style="flex:1;min-width:150px"><input id="gr-note" placeholder="Who is it? e.g. John, USA" style="flex:1;min-width:150px">
        <select id="gr-len" style="padding:8px;border:1px solid var(--line);border-radius:6px;font-size:14px"><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">1 year</option><option value="24">2 years</option><option value="forever" selected>Free forever</option></select>
        <button id="gr-go" style="white-space:nowrap">Give access</button></div>
      <div class="err" id="gr-msg"></div>
      <p style="margin:16px 0 4px"><b>B) Make an access code and send it to them</b> <span class="muted">(they type it in the app — works once)</span></p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;"><input id="gf-note" placeholder="Who is it for? e.g. Li Wei, China" style="flex:1;min-width:170px">
        <select id="gf-len" style="padding:8px;border:1px solid var(--line);border-radius:6px;font-size:14px"><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">1 year</option><option value="24">2 years</option><option value="forever" selected>Free forever</option></select>
        <button id="gf-go" style="white-space:nowrap">Make code</button></div>
      <div id="gf-out" style="margin-top:10px"></div>
      <p style="margin:16px 0 6px"><b>People with free access</b></p><div style="overflow-x:auto"><table id="grants"></table></div>
      <p style="margin:16px 0 6px"><b>Access codes made</b></p><div style="overflow-x:auto"><table id="gifts"></table></div></div>
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
  loadPayments(); loadGrants(); loadHelp(); loadRid(); loadAssistant();
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
  let d;try{d=await (await fetch("/api/admin/mark-paid",{method:"POST",headers:{"x-admin-key":key,"Content-Type":"application/json"},body:JSON.stringify({ref,months:Number($("mp-months").value)})})).json();}catch(e){$("mp-msg").textContent="Could not reach the server.";return;}
  $("mp-msg").textContent=d.ok?("✓ "+d.ref+" unlocked for "+d.months+(d.months>1?" months":" month")+" — until "+d.renewedUntil+". Their app opens by itself in a few seconds."):(d.error||"Error");loadPayments();};
const AK=()=>localStorage.getItem("ledger-admin-key")||"";
const post=async(u,b)=>{try{return await (await fetch(u,{method:"POST",headers:{"x-admin-key":AK(),"Content-Type":"application/json"},body:JSON.stringify(b)})).json();}catch(e){return {ok:false,error:"Could not reach the server."};}};
const lenOf=v=>v==="forever"?{forever:true}:{months:Number(v)};
const untilTxt=u=>u==="2099-12-31"?"Forever":u;
const HV=[["page","Your Facebook page (for “Follow us”)"],["intro","1. What is The Ledger"],["start","2. Getting started (install, PIN, business)"],["stock","3. Put your goods in (stock, PDF, photo)"],["sale","4. Record a sale & receipt"],["credit","5. Returns, expenses & Credit Book"],["store","6. Shop & store, item numbers, many customers"],["staff","7. Staff PINs"],["businesses","8. Many businesses"],["suppliers","9. Suppliers & orders"],["reports","10. Reports, backup & renewing"]];
async function loadAssistant(){
  let d;try{d=await (await fetch("/api/admin/assistant",{headers:{"x-admin-key":AK()},cache:"no-store"})).json();}catch(e){return;}
  if(!d.ok)return;
  $("as-status").textContent=d.configured?("On, using "+d.ai+". Questions today: "+d.today+" of "+d.limit+"."):"Off. In Render, Environment, add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY (paid) to switch it on. Until then the app shows the step-by-step guides.";
  $("as-meet").innerHTML=d.meetings.length?d.meetings.map(m=>"<div>"+esc(m.slot)+" · <b>"+esc(m.name)+"</b> ("+esc(m.business||"")+") ☎ "+esc(m.phone)+" · "+esc(m.mode||"")+" · "+esc(m.topic||"")+"</div>").join(""):"None yet.";
  $("as-calls").innerHTML=d.calls.length?d.calls.map(c=>"<div>"+esc(String(c.createdAt).slice(0,10))+" · <b>"+esc(c.name)+"</b> ☎ "+esc(c.phone)+" · "+esc(c.reason||"")+"</div>").join(""):"None yet.";
  $("as-fb").innerHTML=d.feedback.length?d.feedback.map(f=>"<div>"+"★".repeat(f.rating)+" "+esc(f.message)+" · "+esc(f.name||"Anonymous")+"</div>").join(""):"None yet.";
}
async function loadRid(){
  let d;try{d=await (await fetch("/api/admin/receipt-ids",{headers:{"x-admin-key":AK()},cache:"no-store"})).json();}catch(e){return;}
  if(!d.ok)return;
  $("rid-list").innerHTML=d.list.length?d.list.map(x=>"<div>"+(x.kind==="phone"?"☎ ":"✉ ")+esc(x.show||"")+" — <b>"+esc(x.name||"")+"</b> · "+esc(String(x.at||"").slice(0,10))+"</div>").join(""):"No receipt numbers saved yet.";
}
$("rid-free").onclick=async()=>{const d=await post("/api/admin/receipt-id-free",{value:$("rid-v").value});$("rid-msg").textContent=d.ok?d.msg:(d.error||"Error");loadRid();};
async function loadHelp(){
  let d={videos:{}};try{d=await (await fetch("/api/help-videos",{cache:"no-store"})).json();}catch(e){}
  $("hv-rows").innerHTML=HV.map(([k,l])=>'<label style="font-size:13px;font-weight:600">'+esc(l)+'<input data-hv="'+k+'" value="'+esc((d.videos||{})[k]||"")+'" placeholder="https://www.facebook.com/…" style="display:block;width:100%;margin-top:4px"></label>').join("");
}
$("hv-save").onclick=async()=>{const videos={};document.querySelectorAll("[data-hv]").forEach(i=>{videos[i.dataset.hv]=i.value.trim();});
  const d=await post("/api/admin/help-videos",{videos});$("hv-msg").textContent=d.ok?"✓ Saved — apps pick it up next time they open.":(d.error||"Error");};
async function loadGrants(){
  let d;try{d=await (await fetch("/api/admin/grants",{headers:{"x-admin-key":AK()},cache:"no-store"})).json();}catch(e){return;}
  if(!d.ok)return;
  $("grants").innerHTML='<tr><th>Who</th><th>Code</th><th>Until</th><th></th></tr>'+(d.grants.map(g=>'<tr><td style="text-align:left">'+esc(g.note||"—")+'<div class="muted">'+esc(g.how||"")+'</div></td><td style="text-align:left">'+esc(g.ref)+'</td><td>'+esc(untilTxt(g.until))+'</td><td><button data-rv="'+esc(g.ref)+'" style="background:#fff;color:#8B3A3A;border:1px solid #8B3A3A;padding:5px 9px;font-size:12.5px">Remove</button></td></tr>').join("")||'<tr><td colspan="4" class="muted">Nobody yet.</td></tr>');
  $("gifts").innerHTML='<tr><th>Code</th><th>For</th><th>Length</th><th>Status</th></tr>'+(d.gifts.map(g=>'<tr><td style="text-align:left"><b>'+esc(g.code)+'</b></td><td style="text-align:left">'+esc(g.note||"—")+'</td><td>'+(g.forever?"Forever":g.months+" mo")+'</td><td>'+(g.usedBy==="cancelled"?"cancelled":g.usedBy?"used by "+esc(g.usedBy):'not used yet <button data-gx="'+esc(g.code)+'" style="background:#fff;color:#8B3A3A;border:1px solid #8B3A3A;padding:4px 8px;font-size:12px">Cancel</button>')+'</td></tr>').join("")||'<tr><td colspan="4" class="muted">No codes yet.</td></tr>');
  document.querySelectorAll("[data-rv]").forEach(b=>b.onclick=async()=>{if(!confirm("Remove free access for "+b.dataset.rv+"? Their app will ask for payment again."))return;await post("/api/admin/revoke",{ref:b.dataset.rv});loadGrants();});
  document.querySelectorAll("[data-gx]").forEach(b=>b.onclick=async()=>{if(!confirm("Cancel code "+b.dataset.gx+"?"))return;await post("/api/admin/gift-delete",{code:b.dataset.gx});loadGrants();});
}
$("gr-go").onclick=async()=>{const ref=$("gr-ref").value.trim();if(!ref){$("gr-msg").textContent="Type their LEDGER- code.";return;}
  const d=await post("/api/admin/grant",Object.assign({ref,note:$("gr-note").value},lenOf($("gr-len").value)));
  $("gr-msg").textContent=d.ok?("✓ "+d.ref+" has free access until "+untilTxt(d.renewedUntil)+". Their app opens by itself in a few seconds (or when they tap Check)."):(d.error||"Error");
  if(d.ok){$("gr-ref").value="";$("gr-note").value="";}loadGrants();loadPayments();};
$("gf-go").onclick=async()=>{const note=$("gf-note").value.trim();
  const d=await post("/api/admin/gift",Object.assign({note},lenOf($("gf-len").value)));
  if(!d.ok){$("gf-out").innerHTML='<div class="err">'+esc(d.error||"Error")+'</div>';return;}
  const msg="Hello"+(note?" "+note.split(",")[0]:"")+", here is your free access to The Ledger"+(d.forever?"":" ("+d.months+" month"+(d.months>1?"s":"")+")")+".\\n\\n1. Open https://tholleytech.com and set up the app\\n2. Tap Renew (or the payment screen) → 'Have an access code?'\\n3. Type this code: "+d.code;
  $("gf-out").innerHTML='<div style="background:#fff;border:1px dashed var(--ink);border-radius:8px;padding:12px;text-align:center"><div style="font-size:26px;font-weight:800;letter-spacing:1px">'+esc(d.code)+'</div><div class="muted">'+(d.forever?"Free forever":d.months+" month(s)")+(note?" · "+esc(note):"")+'</div><div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap"><a id="gf-wa" target="_blank" style="background:#25D366;color:#fff;font-weight:700;padding:10px 14px;border-radius:6px;text-decoration:none">Send on WhatsApp</a><button id="gf-cp" style="background:#fff;color:var(--ink);border:1px solid var(--ink)">Copy message</button></div></div>';
  $("gf-wa").href="https://wa.me/?text="+encodeURIComponent(msg);
  $("gf-cp").onclick=async()=>{try{await navigator.clipboard.writeText(msg);$("gf-cp").textContent="Copied ✓";}catch(e){prompt("Copy:",msg);}};
  $("gf-note").value="";loadGrants();};
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
