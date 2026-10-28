THE LEDGER — PAYMENT BACKEND
==============================

What this is
-------------
A small server that automatically confirms subscription payments so people
don't have to wait for you to send them a renewal code by hand.

Two ways it confirms a payment (both wired up, use either or both):

1. SMS-forwarding — works TODAY, no telecom approval needed.
   A phone holding your receiving SIM (Orange Money or MTN MoMo) runs a free
   SMS-forwarder app that sends every incoming SMS to this server. The
   server looks for a reference code like LEDGER-A1B2C3 in the message and
   marks that person's subscription paid automatically.

2. MTN MoMo Open API — ready to switch on once your production credentials
   are approved (see momodeveloper.mtn.com). Until then it's inactive and
   tells you clearly it's not configured yet, instead of failing silently.


PART 1 — Deploy the server
----------------------------
You said you already have hosting — this is a completely standard Node.js
app, so it should run wherever that hosting supports Node (Render, Railway,
a VPS, etc.). Steps are the same shape everywhere:

1. Upload this whole folder (minus node_modules — that gets installed fresh).
2. Set these environment variables in your host's dashboard (copy from
   .env.example, fill in real values):
     SMS_WEBHOOK_SECRET      → a long random string, e.g. run:
                                 node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
     STATUS_CHECK_SECRET     → another long random string
     (leave the MOMO_* variables blank for now)
3. Set the start command to:  npm install && npm start
4. Deploy. Visit your server's URL in a browser — you should see:
     {"ok":true,"service":"The Ledger payment backend",...}
   That confirms it's alive.
5. Note your server's URL (e.g. https://your-app.onrender.com) — you'll
   need to give this to me so I can wire it into the app itself.

Where records live: payment references, staff requests and live sync are
all kept in Upstash Redis (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN),
so nothing is lost when Render restarts or redeploys.

Also set on Render (Environment):
     RECEIVING_NUMBERS       → the number(s) that RECEIVE payments, e.g.
                                 231771466188   (several: comma-separated)
                               (default is 231771466188)


PART 2 — Set up the SMS-forwarder phone
------------------------------------------
How a payment is found:
  - The customer types, in the app, the phone number they pay FROM.
  - Orange Money sends YOUR phone an SMS like
      "You have received USD 2.00 from 0777123456 ..."
  - The forwarder app sends that SMS to this server, which finds the
    customer by that number (or by a LEDGER-XXXXXX code if it appears in
    the SMS), checks the amount (US$2 or L$400), and unlocks their app.
    Their app checks every 15 seconds and opens by itself.

1. Use an Android phone with the SIM that RECEIVES the Orange Money
   payments (+231 77 146 6188). Keep it charged and on the internet.
2. Install a free SMS-to-webhook forwarder from the Play Store, e.g.
   "SMS to URL Forwarder" (any app that can send each SMS to a URL works).
3. Set the URL to (put your real secret instead of THE-SECRET):
     https://the-ledger-payment-backend.onrender.com/api/sms-webhook?secret=THE-SECRET
   Method POST, body JSON:  {"from":"%from%","text":"%text%"}
   (or use the header  Authorization: Bearer THE-SECRET  instead of ?secret=)
4. If the app has a filter, forward only SMS from Orange Money.
5. Test: open https://the-ledger-payment-backend.onrender.com/admin →
   "Payments". Every forwarded payment SMS appears there with its result:
     unlocked / needs review (underpaid) / not matched.
   Anything not matched can be unlocked by hand: type the customer's
   LEDGER-XXXXXX code (shown on their screen) and tap "Unlock by hand".

Keep this phone charged and connected to the internet — if it goes offline,
incoming payment SMS won't get forwarded until it's back online.


PART 3 — When MTN MoMo production access comes through
-----------------------------------------------------------
Once MTN approves your Collections API access:
1. Fill in MOMO_SUBSCRIPTION_KEY, MOMO_API_USER, and MOMO_API_KEY in your
   host's environment variables.
2. In the MTN developer portal, set your callback URL to:
     https://your-server-url/api/momo/callback
3. Redeploy. The server will start actually using MTN's real payment
   confirmations instead of only relying on the SMS-forwarding method.

No code changes needed for this step — it's designed to switch on by
itself once those three values are filled in.


What to send me next
-----------------------
Once this is deployed and you have a live URL, send it to me and I'll wire
the app itself (index.html) to use it — generating each install its own
LEDGER-XXXXXX code, showing it on the subscription screen, and adding a
"Check payment" button that unlocks automatically once your server confirms
the payment landed.


Live sync between owner and staff phones
-------------------------------------------
Endpoints: POST /api/sync/push and POST /api/sync/pull.
Every entry is encrypted on the phone with the ledger's own key before it
is sent, so this server only stores scrambled text. It cannot read sales,
names or amounts.

Storage:
- Default: files in data/sync/. Render's free plan wipes these when the
  server restarts. The phones notice and re-send everything automatically,
  but entries from a phone that stays closed won't reach others until that
  phone opens the app again.
- Recommended: a free Upstash Redis database, which survives restarts.
  1. Sign up at upstash.com → Create Database (Redis, free plan).
  2. Copy "UPSTASH_REDIS_REST_URL" and "UPSTASH_REDIS_REST_TOKEN".
  3. Render → your service → Environment → add both → Save (it redeploys).
  4. The Render log then says: "Live sync storage: Upstash Redis".


Recovery codes (get a business back on a new phone)
------------------------------------------------------
Endpoints: POST /api/recovery/save, /api/recovery/get, /api/recovery/delete.
The owner's phone stores the ledger key LOCKED with the owner's secret
recovery code. The server only sees a fingerprint of the code, never the
code itself, so it cannot open anything. Uses the same storage as live sync —
set up Upstash (above) so recovery data survives Render restarts.


Builder dashboard — active users per country
-----------------------------------------------
Open https://the-ledger-payment-backend.onrender.com/admin and enter your
ADMIN_KEY (set it in Render → Environment). It shows how many phones used the
app today / in 7 days / in 30 days per country, businesses per country,
app versions in use, and browsers.
Phones send only a random device ID, country (from the phone's time zone),
app version, owner/staff, browser and a one-way scrambled business code —
never sales, names, amounts or other records. Kept for 40 days.
