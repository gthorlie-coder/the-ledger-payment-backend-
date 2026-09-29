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

/* ---------------- tiny JSON-file "database" ---------------- */
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) {
    console.error("Couldn't read database, starting fresh:", e.message);
    return {};
  }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
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
  const refMatch = /LEDGER-([A-Z0-9]{6})/i.exec(text || "");
  const amountMatch = /(L\$|LRD|USD|US\$|\$)\s?([\d,]+\.?\d*)/i.exec(text || "");
  let currency = null;
  if (amountMatch) {
    const sym = amountMatch[1].toUpperCase();
    currency = sym === "L$" || sym === "LRD" ? "LRD" : "USD";
  }
  return {
    ref: refMatch ? refMatch[1].toUpperCase() : null,
    amount: amountMatch ? parseFloat(amountMatch[2].replace(/,/g, "")) : null,
    currency,
    raw: text || "",
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
app.get("/", (req, res) => {
  res.json({ ok: true, service: "The Ledger payment backend", time: new Date().toISOString() });
});

/* ---- 1. PWA registers a new install and gets a reference code ---- */
app.post("/api/register", (req, res) => {
  const requested = String(req.body?.country || DEFAULT_COUNTRY).toUpperCase();
  const country = PRICES[requested] ? requested : DEFAULT_COUNTRY;
  const db = loadDB();
  let ref = genRef();
  while (db[ref]) ref = genRef(); // avoid the rare collision
  db[ref] = {
    createdAt: today(),
    country,
    paid: false,
    paidAt: null,
    renewedUntil: null,
    lastAmount: null,
    lastRawSms: null,
  };
  saveDB(db);
  const p = priceFor(country);
  res.json({ ok: true, ref: `LEDGER-${ref}`, country, priceUsd: p.usd, priceLrd: p.lrd });
});

/* ---- 2. PWA polls this to check if payment has landed ---- */
app.get("/api/status/:ref", (req, res) => {
  const code = (req.params.ref || "").replace(/^LEDGER-/i, "").toUpperCase();
  const db = loadDB();
  const record = db[code];
  if (!record) return res.status(404).json({ ok: false, error: "Unknown reference code" });
  res.json({
    ok: true,
    paid: !!record.paid,
    renewedUntil: record.renewedUntil,
    active: record.renewedUntil ? record.renewedUntil >= today() : false,
  });
});

/* ---- 3. SMS-forwarder app posts every incoming SMS here ----
   Protect this with SMS_WEBHOOK_SECRET so a stranger can't fake payments.
   Accepts JSON { "text": "..." } or plain text body, whichever your
   SMS-forwarder app sends. */
app.post("/api/sms-webhook", requireSecret(process.env.SMS_WEBHOOK_SECRET), (req, res) => {
  const text = typeof req.body === "string" ? req.body : req.body?.text || req.body?.message || "";
  const { ref, amount, currency, raw } = parseIncomingSms(text);

  if (!ref) {
    // Not every SMS is a payment (balance alerts, promos, etc.) — that's fine.
    return res.json({ ok: true, matched: false, reason: "No LEDGER- reference found in message" });
  }

  const db = loadDB();
  const record = db[ref];
  if (!record) {
    return res.json({ ok: true, matched: false, reason: `Reference ${ref} not found — may be a typo or old code` });
  }

  record.lastAmount = amount;
  record.lastCurrency = currency;
  record.lastRawSms = raw;

  const check = checkAmount(record.country || DEFAULT_COUNTRY, amount, currency);
  if (check !== "ok") {
    // Don't unlock. Keep the details so you can review and use /api/mark-paid if it's genuine.
    record.pendingReview = { reason: check, amount, currency, at: today() };
    db[ref] = record;
    saveDB(db);
    const p = priceFor(record.country || DEFAULT_COUNTRY);
    console.log(`⚠️  LEDGER-${ref}: payment NOT unlocked (${check}) — got ${currency || "?"} ${amount ?? "?"}, expected USD ${p.usd}${p.lrd ? ` or LRD ${p.lrd}` : ""}`);
    return res.json({ ok: true, matched: true, unlocked: false, reason: check, ref: `LEDGER-${ref}` });
  }

  record.paid = true;
  record.paidAt = today();
  record.renewedUntil = addDays(today(), SUBSCRIPTION_DAYS);
  delete record.pendingReview;
  db[ref] = record;
  saveDB(db);

  console.log(`✅ Payment matched for LEDGER-${ref} — active until ${record.renewedUntil}`);
  res.json({ ok: true, matched: true, unlocked: true, ref: `LEDGER-${ref}`, renewedUntil: record.renewedUntil });
});

/* ---- 4. Manual/admin override — mark a reference paid by hand ----
   Useful if you confirm a payment yourself (e.g. saw it in your Orange Money
   app) and the SMS-forwarder missed it for some reason. */
app.post("/api/mark-paid", requireSecret(process.env.SMS_WEBHOOK_SECRET), (req, res) => {
  const code = (req.body?.ref || "").replace(/^LEDGER-/i, "").toUpperCase();
  const db = loadDB();
  if (!db[code]) return res.status(404).json({ ok: false, error: "Unknown reference code" });
  db[code].paid = true;
  db[code].paidAt = today();
  db[code].renewedUntil = addDays(today(), SUBSCRIPTION_DAYS);
  saveDB(db);
  res.json({ ok: true, ref: `LEDGER-${code}`, renewedUntil: db[code].renewedUntil });
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
  const country = loadDB()[refCode]?.country || DEFAULT_COUNTRY;
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
    const db = loadDB();
    const code = ref.replace(/^LEDGER-/i, "").toUpperCase();
    if (db[code]) {
      db[code].momoReferenceId = referenceId;
      saveDB(db);
    }
    res.json({ ok: true, referenceId, status: "PENDING" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// MTN calls this automatically when a Request-to-Pay completes.
// Configure this URL as your callback host in the MTN developer portal.
app.post("/api/momo/callback", (req, res) => {
  console.log("MTN MoMo callback received:", JSON.stringify(req.body));
  const { referenceId, status } = req.body || {};
  if (status === "SUCCESSFUL" && referenceId) {
    const db = loadDB();
    const code = Object.keys(db).find((k) => db[k].momoReferenceId === referenceId);
    if (code) {
      db[code].paid = true;
      db[code].paidAt = today();
      db[code].renewedUntil = addDays(today(), SUBSCRIPTION_DAYS);
      saveDB(db);
      console.log(`✅ MoMo payment confirmed for LEDGER-${code}`);
    }
  }
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
const STAFF_DB_PATH = path.join(__dirname, "data", "staff-requests.json");
function loadStaffDB() {
  try {
    if (!fs.existsSync(STAFF_DB_PATH)) return {};
    return JSON.parse(fs.readFileSync(STAFF_DB_PATH, "utf8"));
  } catch (e) {
    console.error("Couldn't read staff requests, starting fresh:", e.message);
    return {};
  }
}
function saveStaffDB(db) {
  fs.mkdirSync(path.dirname(STAFF_DB_PATH), { recursive: true });
  fs.writeFileSync(STAFF_DB_PATH, JSON.stringify(db, null, 2));
}
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// Returns the shop record (creating it on first use) or null if the key is wrong.
function openShop(db, shopId, shopKey) {
  if (!/^[a-f0-9]{24}$/.test(shopId || "") || !/^[a-f0-9]{64}$/.test(shopKey || "")) return null;
  const keyHash = sha256(shopKey);
  if (!db[shopId]) db[shopId] = { keyHash, requests: {} };
  if (db[shopId].keyHash !== keyHash) return null;
  // tidy: forget answered requests older than 30 days
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [id, r] of Object.entries(db[shopId].requests)) {
    if (r.status !== "pending" && Date.parse(r.decidedAt || r.at) < cutoff) delete db[shopId].requests[id];
  }
  return db[shopId];
}

// Staff phone sends a request
app.post("/api/staff/request", (req, res) => {
  const { shopId, shopKey, requestId, name } = req.body || {};
  const db = loadStaffDB();
  const shop = openShop(db, shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!/^[A-Za-z0-9]{6,20}$/.test(requestId || "") || !cleanName) return res.status(400).json({ ok: false, error: "requestId and name are required" });
  const pendingCount = Object.values(shop.requests).filter((r) => r.status === "pending").length;
  if (!shop.requests[requestId] && pendingCount >= 50) return res.status(429).json({ ok: false, error: "Too many pending requests" });
  if (!shop.requests[requestId]) {
    shop.requests[requestId] = { id: requestId, name: cleanName, status: "pending", at: new Date().toISOString() };
    saveStaffDB(db);
  }
  res.json({ ok: true, status: shop.requests[requestId].status });
});

// Owner phone asks for pending requests
app.post("/api/staff/list", (req, res) => {
  const { shopId, shopKey } = req.body || {};
  const db = loadStaffDB();
  const shop = openShop(db, shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  saveStaffDB(db);
  const requests = Object.values(shop.requests).filter((r) => r.status === "pending");
  res.json({ ok: true, requests });
});

// Owner phone approves or declines
app.post("/api/staff/decide", (req, res) => {
  const { shopId, shopKey, requestId, approve } = req.body || {};
  const db = loadStaffDB();
  const shop = openShop(db, shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  const r = shop.requests[requestId];
  if (!r) return res.status(404).json({ ok: false, error: "Unknown request" });
  r.status = approve ? "approved" : "declined";
  r.decidedAt = new Date().toISOString();
  saveStaffDB(db);
  res.json({ ok: true, status: r.status });
});

// Staff phone checks whether it was approved
app.post("/api/staff/status", (req, res) => {
  const { shopId, shopKey, requestId } = req.body || {};
  const db = loadStaffDB();
  const shop = openShop(db, shopId, shopKey);
  if (!shop) return res.status(401).json({ ok: false, error: "Unknown shop" });
  const r = shop.requests[requestId];
  if (!r) return res.json({ ok: true, status: "unknown" });
  res.json({ ok: true, status: r.status, name: r.name });
});

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
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const SYNC_MAX_ITEMS_PER_SHOP = 60000;
const syncCache = new Map(); // shopId -> shop (kept in memory, saved in the background)
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
async function syncStoreGet(shopId) {
  if (USE_REDIS) {
    const v = await redisCmd(["GET", "ledger-sync:" + shopId]);
    return v ? JSON.parse(v) : null;
  }
  const f = path.join(SYNC_DIR, shopId + ".json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
async function syncStorePut(shopId, shop) {
  const text = JSON.stringify(shop);
  if (USE_REDIS) return redisCmd(["SET", "ledger-sync:" + shopId, text]);
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(path.join(SYNC_DIR, shopId + ".json"), text);
}
function syncSaveSoon(shopId) {
  if (syncSaveTimers.has(shopId)) return;
  syncSaveTimers.set(shopId, setTimeout(async () => {
    syncSaveTimers.delete(shopId);
    try { await syncStorePut(shopId, syncCache.get(shopId)); }
    catch (e) { console.error("Sync save failed for", shopId, e.message); syncSaveSoon(shopId); }
  }, 800));
}
// Returns the shop (creating it on first use) or null if the key is wrong.
async function openSyncShop(shopId, shopKey) {
  if (!/^[a-f0-9]{24}$/.test(shopId || "") || !/^[a-f0-9]{64}$/.test(shopKey || "")) return null;
  const keyHash = sha256(shopKey);
  let shop = syncCache.get(shopId);
  if (!shop) {
    shop = await syncStoreGet(shopId);
    if (!shop) { shop = { keyHash, epoch: crypto.randomBytes(8).toString("hex"), seq: 0, items: {} }; syncSaveSoon(shopId); }
    syncCache.set(shopId, shop);
  }
  if (shop.keyHash !== keyHash) return null;
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
      if (!old && Object.keys(shop.items).length >= SYNC_MAX_ITEMS_PER_SHOP) return res.status(413).json({ ok: false, error: "Shop is full" });
      shop.seq += 1;
      shop.items[it.r] = { u: it.u, s: shop.seq, iv: it.iv, d: it.d };
      stored++;
    }
    if (stored) syncSaveSoon(shopId);
    res.json({ ok: true, epoch: shop.epoch, seq: shop.seq, stored });
  } catch (e) {
    console.error("sync/push:", e.message);
    res.status(500).json({ ok: false, error: "Server error" });
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
    const changed = Object.entries(shop.items).filter(([, v]) => v.s > since).sort((a, b) => a[1].s - b[1].s);
    const page = changed.slice(0, LIMIT);
    res.json({
      ok: true,
      epoch: shop.epoch,
      seq: page.length ? page[page.length - 1][1].s : shop.seq,
      more: changed.length > LIMIT,
      items: page.map(([r, v]) => ({ r, u: v.u, iv: v.iv, d: v.d })),
    });
  } catch (e) {
    console.error("sync/pull:", e.message);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`The Ledger payment backend running on port ${PORT}`);
  console.log(`Liberia price: USD ${PRICES.LR.usd}${PRICES.LR.lrd ? ` / LRD ${PRICES.LR.lrd}` : " (LRD not auto-accepted)"}`);
  console.log(`MTN MoMo configured: ${momoConfigured() ? "yes" : "no (SMS-forwarding is active instead)"}`);
  console.log(`Live sync storage: ${USE_REDIS ? "Upstash Redis (kept across restarts)" : "local files (wiped when Render restarts; phones re-send automatically)"}`);
});
