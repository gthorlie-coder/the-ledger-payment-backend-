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
app.use(express.json());
app.use(express.text({ type: ["text/plain", "text/*"] })); // some SMS-forwarder apps POST plain text

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "subscriptions.json");
const SUBSCRIPTION_DAYS = 30;

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
  const amountMatch = /(?:L\$|LRD|USD|US\$|\$)\s?([\d,]+\.?\d*)/i.exec(text || "");
  return {
    ref: refMatch ? refMatch[1].toUpperCase() : null,
    amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : null,
    raw: text || "",
  };
}
function genRef() {
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

/* ==================================================================
   ROUTES
   ================================================================== */

// Health check — visit this URL in a browser to confirm the server is alive.
app.get("/", (req, res) => {
  res.json({ ok: true, service: "The Ledger payment backend", time: new Date().toISOString() });
});

/* ---- 1. PWA registers a new install and gets a reference code ---- */
app.post("/api/register", (req, res) => {
  const db = loadDB();
  let ref = genRef();
  while (db[ref]) ref = genRef(); // avoid the rare collision
  db[ref] = {
    createdAt: today(),
    paid: false,
    paidAt: null,
    renewedUntil: null,
    lastAmount: null,
    lastRawSms: null,
  };
  saveDB(db);
  res.json({ ok: true, ref: `LEDGER-${ref}` });
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
  const { ref, amount, raw } = parseIncomingSms(text);

  if (!ref) {
    // Not every SMS is a payment (balance alerts, promos, etc.) — that's fine.
    return res.json({ ok: true, matched: false, reason: "No LEDGER- reference found in message" });
  }

  const db = loadDB();
  const record = db[ref];
  if (!record) {
    return res.json({ ok: true, matched: false, reason: `Reference ${ref} not found — may be a typo or old code` });
  }

  record.paid = true;
  record.paidAt = today();
  record.renewedUntil = addDays(today(), SUBSCRIPTION_DAYS);
  record.lastAmount = amount;
  record.lastRawSms = raw;
  db[ref] = record;
  saveDB(db);

  console.log(`✅ Payment matched for LEDGER-${ref} — active until ${record.renewedUntil}`);
  res.json({ ok: true, matched: true, ref: `LEDGER-${ref}`, renewedUntil: record.renewedUntil });
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
  const { phoneNumber, ref, amount, currency } = req.body || {};
  if (!phoneNumber || !ref) return res.status(400).json({ ok: false, error: "phoneNumber and ref are required" });

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
        amount: String(amount || "0.50"),
        currency: currency || "USD",
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

app.listen(PORT, () => {
  console.log(`The Ledger payment backend running on port ${PORT}`);
  console.log(`MTN MoMo configured: ${momoConfigured() ? "yes" : "no (SMS-forwarding is active instead)"}`);
});
