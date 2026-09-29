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

Important: data/subscriptions.json is where payment records live. On some
free hosting tiers, the filesystem resets on every redeploy — if that
happens to you, ask me to switch this to a proper hosted database instead
(a quick change, just needs your host's specifics first).


PART 2 — Set up the SMS-forwarder phone
------------------------------------------
1. Get a basic Android phone (even an old one) and put the SIM that
   receives your Orange Money / MoMo payments into it.
2. Install a free SMS-to-webhook forwarder app — search Play Store for
   "SMS to URL Forwarder" or similar (there are a few free ones; any that
   let you set a custom URL + a custom header work).
3. Configure it to POST to:
     https://your-server-url/api/sms-webhook
   With this header:
     Authorization: Bearer <your SMS_WEBHOOK_SECRET value>
   And the SMS text sent as JSON: {"text": "<the message>"}
   (Some apps call this field "message" instead of "text" — the server
   accepts either.)
4. Send yourself a test payment with a fake reference (e.g. text
   "test LEDGER-ABC123 USD 2.00" to that phone) and confirm you see
   "✅ Payment matched" in your server's logs.

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
