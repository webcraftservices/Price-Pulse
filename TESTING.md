# PricePulse Stage 2 — Live Test Kit

Run this yourself, since I have no internet access or browser in my sandbox
(confirmed: my sandbox's egress blocks google.serper.dev,
generativelanguage.googleapis.com, and npm's registry — so I can't install
deps, call Serper, or click a UI from here). Everything below runs the
*actual, unmodified* app code — I'm not asking you to test a mock.

Paste back terminal output / screenshots for whichever tests you run and
I'll fill in the TEST | RESULT | EVIDENCE | FIX REQUIRED table from that,
and fix anything that fails.

---

## 0. Setup (one time)

```bash
cd PricePulse
npm install
```

Check `backend/.env` has real values for `GEMINI_API_KEY` and
`SERPER_API_KEY` (it already does in your project — don't paste them back
to me).

Start the backend:

```bash
node backend/server.js
```

You should see `Server running on http://localhost:5000`. Leave this
terminal open — its output is exactly the `[COMPARE] ...` log lines
referenced below.

Serve the frontend (don't just double-click index.html — use a static
server so relative asset paths behave):

```bash
npx serve .
# or: python3 -m http.server 8080
```

Open the printed URL (e.g. `http://localhost:8080`) in your browser.

> Note: `start.bat` / `server.ps1` in the project root are a **leftover
> PowerShell prototype from before the Node backend existed** — they're not
> part of Stage 2 and shouldn't be used. The real backend is
> `backend/server.js`. Worth deleting later to avoid confusion, but I
> haven't touched them since you didn't ask me to.

---

## 1. Automated tests — real Serper API, real matching/comparison code

Run from the `backend/` folder, server does **not** need to be running for
these (they call the service functions directly, not over HTTP):

```bash
cd backend

# Test 5/6/7/8/9/10 — live Serper parsing, store names, prices, availability, URLs
node scripts/run-live-tests.js query "boAt Airdopes 141"

# Test 3/4/11/13/14/15/16 — structured product, variant handling, best offer logic
node scripts/run-live-tests.js product '{"brand":"Samsung","model":"Galaxy M14","storage":"128GB"}'
node scripts/run-live-tests.js product '{"brand":"Samsung","model":"Galaxy M14","storage":"256GB"}'
# ^ run both storage variants back to back and compare: results/prices should differ,
#   a 128GB listing should never show up as a confident match for the 256GB run and vice versa

# Test 12 — accessory rejection: pick any phone/electronics model you know is real
node scripts/run-live-tests.js product '{"brand":"Apple","model":"iPhone 15","storage":"128GB"}'
# ^ check the SUMMARY: any "case"/"cover"/"screen guard" listings should land in
#   "Possible matches", not "Confident matches"

# Test 19 — obscure/rare product likely to return few results
node scripts/run-live-tests.js query "<some very specific niche product you know has 1 listing>"

# Test 20 — no comparable result
node scripts/run-live-tests.js query "zzqxvthisisnotarealproductnamezz123"

# Test 22 — missing price: no direct way to force this from outside, see section 3 below
```

Each command prints:
- the exact query sent to Serper
- `[COMPARE]` log lines (also visible in the `node backend/server.js` terminal if it's running)
- the full JSON the frontend would receive
- a SUMMARY with explicit `CHECK: ... -> OK/FAIL` lines for the best-offer logic

**Paste the full terminal output back to me for each command you run.**

---

## 2. Manual browser tests — things I genuinely cannot do without a browser

For each, open DevTools (F12) → Network tab before starting, and keep the
`node backend/server.js` terminal visible so you can copy its `[COMPARE]`
lines.

| # | Test | What to check | Evidence to paste back |
|---|---|---|---|
| 1 | Find a real product via image upload | Product gets identified | Screenshot of Find result |
| 2 | Click "Compare Prices" | Navigates to Compare, search starts automatically (no re-upload/URL prompt) | Screenshot |
| 3 | — | In DevTools Network tab, click the `compare-text` request → Payload tab | Screenshot of the request payload — confirm it's `{"product": {...}}` with brand/model/storage, not just a plain string |
| 4 | — | Same request | Same screenshot covers this |
| 17 | Compare page shows results | Real store names, real prices, best price highlighted | Screenshot |
| 18 | Click every "View Deal" | Each opens the exact URL shown in the card, in a new tab, and it's a real product/search page (not a Google redirect, not 404) | For each: the store name shown in PricePulse + the URL the browser actually opened |
| 23 | Find → Compare → back button → Find again | Find page still works normally, orb/upload untouched | Confirm pass/fail only |

---

## 3. Failure-path tests (21, 22) — how to actually trigger them

**Test 21 — invalid/failed Serper response:**
Temporarily break the key to force a real failure (don't paste the real
key back to me):

```bash
cd backend
SERPER_API_KEY=invalid_key_test node scripts/run-live-tests.js query "boAt Airdopes 141"
```
Expected: the script's `--- THREW ---` block prints a clean error message
(not a crash/stack trace), and if you do this via the actual running
server + browser instead, the Compare page should show a readable error
banner, not a blank/broken page.

**Test 22 — missing price:**
I can't force Serper to omit a price field on demand. The honest way to
check this is to run several `query`/`product` searches (section 1) and
look at the SUMMARY's "Offers with 'Price unavailable'" count — if any
real listing comes back with no price, this is naturally exercised and
you'll see it in the JSON as `"price": null` and in the UI as "Price
unavailable" text (never a fabricated number).

---

## 4. Results table — paste this back filled in

```
TEST | RESULT | EVIDENCE | FIX REQUIRED
1    |        |          |
2    |        |          |
3    |        |          |
...
```

Once I have real output/screenshots I'll fill in exact failure diagnosis
(file/function/cause/smallest fix) for anything that fails — same as I'd
do if I'd run it myself.
