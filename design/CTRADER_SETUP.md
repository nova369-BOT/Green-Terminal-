# Connecting cTrader to Green Terminal — step-by-step

Goal: get live tick data (US30, XAUUSD, EURUSD…) flowing into Green Terminal so
the footprint chart shows real numbers.

The chain is: **IC Markets** (gives the prices) → **cTrader** (the platform) →
**Open API** (the data pipe) → **Green Terminal**.

You need all three. cTrader has no price data of its own — the broker supplies it.

Total time: about 20 minutes of clicking, then a wait for approval (can be a few
days). **Start Part B today** so the waiting happens in the background.

---

## PART A — Get a free IC Markets cTrader demo account

No money, no card. A demo gives you the same price feed as live for charting.

1. Go to **https://www.icmarkets.com**
2. Find **"Try a free demo"** (usually top-right or under *Trading Accounts*).
3. Fill in your name, email, phone, country.
4. When it asks which **platform**, choose **cTrader**. ← this matters. If you
   pick MetaTrader you cannot use the Open API.
5. Choose account currency (USD is fine) and virtual balance (default is fine).
6. Submit. You will get emails containing:
   - your **cTrader ID (cTID)** — an email address + password you create
   - your demo **account number**
7. Log in once at **https://ct.icmarkets.com** to confirm it works, and check you
   can see a chart for **US30** or **XAUUSD**.

✅ **Done when:** you can log into cTrader web and see live prices moving.

---

## PART B — Register an Open API application

This is what gives Green Terminal permission to read your data.

1. Go to **https://openapi.ctrader.com/apps**
2. Log in with the **cTrader ID** from Part A (not your IC Markets portal login).
3. Click **"Add new App"**.
4. **Application name:** `Green Terminal`
5. **Description** — copy and paste this (a detailed description gets approved
   faster, because a human at Spotware reads it):

   > Green Terminal is a personal web-based charting and market-analysis
   > terminal. It uses the cTrader Open API to stream tick and depth-of-market
   > data for my own trading accounts in order to render order-flow footprint,
   > volume profile and delta charts. Read-only market data use; no third-party
   > access and no copy trading.

6. Click **"+ Add redirect URL"** and add **both** of these, one at a time:

   ```
   https://green-terminal.onrender.com/api/ctrader/callback
   http://localhost:7787/api/ctrader/callback
   ```

   ⚠️ The greyed-out default redirect URL that already exists is **playground
   only** and will NOT work from code. You must add your own, exactly as above.

7. Fill in contact name, surname, phone.
8. Click **Save**.

Your app now appears in the list with status **"Submitted"**.

9. **Wait for approval.** Spotware reviews it manually and emails you. The status
   changes to **"Active"**. This can take anywhere from a few hours to a few
   days. Nothing else can proceed until this happens.

10. Once it says **Active**, click the app's **View / Credentials** button and
    copy two values:
    - **Client ID** — a long string, about 54 characters
    - **Client Secret** — about 50 characters

✅ **Done when:** app status is *Active* and you have the two values.

---

## PART C — Give the credentials to Green Terminal (safely)

🔒 **Never paste the Client Secret into a chat message, a GitHub issue, or any
file in this repository.** Treat it like a password. Anyone holding it can act
as your application.

Put them into Render instead, where they stay encrypted:

1. Go to **https://dashboard.render.com**
2. Open the **green-terminal** service.
3. Left menu → **Environment**.
4. Click **Add Environment Variable** and add these three:

   | Key | Value |
   |---|---|
   | `CTRADER_CLIENT_ID` | the Client ID from Part B step 10 |
   | `CTRADER_CLIENT_SECRET` | the Client Secret from Part B step 10 |
   | `CTRADER_ENV` | `demo` |

5. Click **Save Changes**. Render redeploys automatically.

✅ **Done when:** the three variables are saved in Render.

---

## PART D — Connect your account (one click, in Green Terminal)

This part is automated — you do not need to handle tokens or run any commands.

1. Open Green Terminal.
2. Go to the cTrader connection panel and press **Connect cTrader**.
3. A cTrader page opens asking you to allow access. Pick your demo account and
   press **Allow access**.
4. You are sent back to Green Terminal, which stores the access token itself.

The permission requested is **read-only market data** (`accounts` scope), so the
app can see prices and your account list but **cannot place or close trades**.
We can widen that later if you ever want to trade from inside GT.

✅ **Done when:** the panel shows *Connected* and your broker name.

---

## Going live later

When you want real-money data instead of demo:

1. Open a live IC Markets cTrader account and fund it.
2. In Render, change `CTRADER_ENV` from `demo` to `live`.
3. Press **Connect cTrader** again and authorise the live account.

No code changes. Demo and live are different servers
(`demo.ctraderapi.com:5035` / `live.ctraderapi.com:5035`), which that one
variable selects.

---

## If something goes wrong

| Problem | Cause / fix |
|---|---|
| App stuck on "Submitted" | Normal. Spotware reviews manually; wait for the email. A vague description slows this down. |
| "Malformed client_id" | You used the playground default redirect URL. Use one of the two from Part B step 6. |
| "ACCESS_DENIED / credentials not valid" | Client ID or Secret copied with a missing character, or the app is not Active yet. |
| Connected, but no US30 | IC Markets names indices differently per account type. The symbol list is read from your account on connect, so pick the name shown there. |
| Works on demo, fails on live | Live accounts must authorise against the live host. Change `CTRADER_ENV=live` and reconnect. |

---

## What this gets you

Once connected, Green Terminal receives:

- **Tick prices** → the footprint buy/sell split, delta, POC, value area
- **Depth of market (Level II)** → the DOM ladder on the right of the chart
- **Historical bars** → the candles underneath the footprint

**One honest note:** spot FX and CFDs have no central exchange, so there is no
official traded volume and no official buy/sell flag. Green Terminal derives
both from tick activity (uptick = buy, downtick = sell). Published research puts
tick volume at roughly 0.85–0.90 correlation with real volume on majors, and the
tick rule at roughly 72–80% accuracy on side. That is good enough to trade from
— every FX footprint product works this way — but it is an **estimate**, and
Green Terminal labels it as one rather than pretending it is exchange data.

---

## Running under Docker

Everything above works the same, with three Docker-specific points.

### 1. Credentials go in a `.env` file, not the compose file

`docker-compose.yml` is committed to git, so it must never contain a secret.
It reads the values from a local `.env`, which is gitignored:

```bash
cp .env.example .env
# edit .env and paste your Client ID and Secret
docker compose up --build
```

`docker compose` picks up `.env` from the project directory automatically.

### 2. Register the Docker redirect URI

Your browser reaches the container on the published port, so add **both** of
these to the Open API application's redirect URL list:

```
http://localhost:7787/api/ctrader/callback
http://127.0.0.1:7787/api/ctrader/callback
```

`localhost` and `127.0.0.1` are different strings and the match is exact, so
register both rather than guessing which one you will type.

### 3. Rebuild when dependencies change

The compose file mounts the checkout read-only at `/app`, so ordinary code
changes need no rebuild — just restart. But `protobuf` was added to
`pyproject.toml` for cTrader, and installed dependencies live in the image:

```bash
docker compose up --build        # needed after a dependency change
docker compose up                # enough for day-to-day code changes
```

### Tokens survive restarts

`LSE_TERMINAL_CONFIG_DIR=/tmp/lse-terminal` is backed by the named volume
`gt-config`, and that is where the OAuth tokens are written. So
`docker compose restart` keeps you connected; you only reconnect if you run
`docker compose down -v`, which deletes the volume.

### Check it worked

```bash
curl -s http://127.0.0.1:7787/api/ctrader/status
```

Expect `"configured": true`. Before you press Connect it will correctly say
`"connected": false` — that is honest, not an error.
