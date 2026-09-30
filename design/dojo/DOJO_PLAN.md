# GT DOJO — Product Plan (Phase 2.5)

_Status: APPROVED IDEA — design locked 2026-09-30, build not started._
_Screens: `shots/dojo-home.png`, `dojo-drill.png`, `dojo-blind-drill.png`,
`dojo-league-forecasts.png`, `dojo-bout.png`, `dojo-wallet.png`,
`dojo-multiplier-drill.png`, `dojo-bout-prize.png`, `dojo-funding-pipeline.png`_
_(concept renders — pixel guides for the build, not screenshots; the mockup →
approval → code loop applies per screen at build time.)_

---

## 1. What it is

**GT DOJO — the proving ground.** A training game played on real historical
markets inside Green Terminal. Users trade blind scenarios bar-by-bar
(BUY / SELL / SKIP), earn ranks backed by *honest* stats, get coached by the
agent, and — via partner prop firms — convert verified skill into funding.

**Positioning line (the moat):** _“We profit when traders get good, not when
they lose.”_ Every competitor in the space (prop-fee mills, signal bots,
binary casinos) monetizes hope and failure. The Dojo monetizes formation.
That inversion is the brand.

**Target:** the “deposit-lose-deposit-lose” retail cycle — especially the
Telegram-native emerging-markets wave — at its *realization moment*.

## 2. The Blind Drill (core loop, user-designed anti-cheat)

- The engine draws a scenario **at random** from a sealed pool
  (2008–2026 history × many instruments × random offsets × all timeframes).
- User picks **only the timeframe**. Algorithm picks market, date, segment.
- **Instrument sealed, date hidden, price re-based to 100** — no fingerprint
  lookup possible.
- **5:00 analysis window on a clock**, then bars release one-by-one as the
  trader decides BUY / SELL / SKIP (skipping is scored — selectivity is a
  skill). One position, max N trades per drill.
- Calendar leaks (weekend gaps, session shapes, famous crash silhouettes)
  are stripped or normalized in ranked mode.
- **Review after completion:** instrument/date revealed, trade-by-trade
  coach annotations with receipts (tilt events, stop moves, overtrading).

**Sealing rule (engineering):** the client never receives future bars or the
scenario ID before reveal — bars are released by the engine per decision.
Offline solo drills are engine-sealed (cheating fools only yourself);
everything with money or leaderboards is **server-sealed** (streamed bars,
timestamped decisions) in the multi-user phase.

**Analysis tools in-drill:** GT drawing suite (trendlines, zones) + the
metric lab (ATR, realized vol, session range) — all future-blind by
construction (computed from released bars only).

## 3. The Aviator feeling — without the casino (legal twin)

The emotionally strong part of Aviator is *cash-out tension over a rising
curve*. A trading drill is mechanically identical and fully legal:

| Aviator | Blind Drill |
|---|---|
| Place bet | One position, fixed risk |
| Multiplier rising | Live equity + **score multiplier** (1X / 2X / 5X tiers) |
| The crash | Hidden future unfolds |
| Cash out | EXIT vs HOLD each bar, decision clock draining |

Score multipliers amplify **rank points only** (higher tiers score sharper
for wins AND charge sharper for drawdowns). Equity is always paper.
_“Skill is the stake.”_

## 4. Money architecture (max-legal)

**HARD BOUNDARY — what we never sell:** deposits staked against outcomes,
entry-fee prize pools paid from losers' stakes, or any “prediction” payout.
That configuration is a gambling operator (UK/EU binary ban; Nigeria
National Lottery Act; CFTC in the US; Paystack/Flutterwave terminate
unlicensed gaming merchants). The Dojo's money must come from value given,
never from customers losing.

1. **Wallet + deposit anytime — transaction UX modeled on Pocket Option's
   rails, products-only underneath** (the user's explicit ask: "handle
   transactions exactly the way they handle theirs, without the gambling"):
   - **Deposit-anytime rails:** card, bank transfer, crypto (BTC/USDT),
     mobile money — whatever Paystack/Flutterwave (NG) and Stripe (rest of
     world) hand us. Low minimum (₦1,000–5,000 / $5): inclusive by design,
     same reason Pocket Option's $5 entry converts.
   - **Instant balance credit**, account currency NGN or USD, balance shown
     in both (like the wallet screen concept `dojo-wallet.png`).
   - **Withdraw anytime:** unused balance refunds to source; sponsored-bout
     prizes withdrawable after one-account-per-trader verification.
   - **Bonuses in products, not cash** (deposit ₦10,000 → +2 Pro days;
     refer a friend → both get a scenario pack). Cash bonuses smell like
     gaming to payment providers; product bonuses are clean commerce.
   - **Itemized receipts** on every spend ("Pro week", "Scenario pack:
     2008") — merchant category stays education/software, which is exactly
     what keeps Paystack/Flutterwave from treating us as gaming.
   - **What the balance buys:** Pro days, scenario packs, eval tickets —
     and the wallet is shared GT-wide (terminal Pro can come off the same
     balance later), so every deposit lifts the whole product.
   - Refund rule: unused product balance withdrawable anytime; spent
     products final. Clean commerce, documented.
2. **Pro days** (no subscription lock): unlimited drills + coach + full
   stat record. Pay-as-you-go access — the user's anti-“subscription” wish
   is honored without gambling mechanics.
3. **Scenario packs:** curated history (2008, COVID crash, LSE earnings
   season). Content margin.
4. **Sponsored cash bouts:** weekly, **free entry**, prizes funded by GT as
   marketing spend. “Prizes are platform marketing, never other players'
   money.”
5. **Prop-firm pipeline (the flip of FTMO economics):** verified Dojo
   record (win rate × drawdown × tilt-rate trend over N drills) +
   discounted evals at partner firms; GT earns referral/licensing revenue
   when **traders improve**, never when they fail. Funding decisions and
   payouts belong to partners entirely.
6. **B2B engine licensing (the big tail):** white-label the Blind Drill
   engine to licensed operators (educators, prop firms, brokers) who may
   run staked formats **under their own licenses**. GT supplies product +
   takes rev share, never touches the regulation.

## 5. Distribution

- **Door 1 (build first):** `DOJO` tab inside Green Terminal — reuses the
  chart, replay, metrics, drawing suite, agent rail. Zero new infra.
- **Door 2 (after users prove retention):** thin web companion on the same
  engine (accounts + server sealing = the multi-user phase), **Telegram
  bot** under distribution: daily drill links, group leaderboards, rank
  movement, metric alerts with receipts, group bouts. Traders live in
  Telegram; the bot is free acquisition.

**Architecture rule:** Dojo engine (pool, scoring, session logic, coach
hooks) is built UI-agnostic on the FastAPI server from day one — the web
door is then an auth + rendering job, not a rewrite.

## 6. Competition honesty

Checked 2026-09-30: toy-scale pieces exist (MoMoney lessons app, Forex
Hero school app, Simul8or badges/battles) — category validated,
**leaderless**. Nobody has: serious-terminal drills, truthful stat-backed
ranks, AI coach with receipts, funding pipeline. We don't claim “nobody
has done this”; we claim nobody has done it *for real*.

## 7. Phasing & exit gates

- **D1 — Blind Drills v1 (solo, offline):** sealed pool, decision clock,
  skip-scoring, analysis tools, review reveal, true-stats record. _Gate:
  user finishes 5 drills and starts a 6th unprompted._
- **D2 — Coach + ranking:** agent receipts, belts (Paper → Trader →
  Operator → Master), streaks. _Gate: 7-day retention on drills > 20% of
  actives._
- **D3 — Wallet + Pro days + packs (payments):** deposit/withdraw,
  Paystack. _Gate: ≥ 5% of weekly drillers pay anything._
- **D4 — Accounts + server sealing + leagues/bouts (multi-user):** the
  only server-heavy phase. _Gate: bouts fill weekly without paid ads._
- **D5 — Prop pipeline + B2B licensing:** first partner signed, first
  white-label pilot. _Gate: first non-user revenue._

## 8. Open risks (honest list)

- Retention risk: drills must be *fun*, not homework — the D1 gate guards.
- Solo-capacity: D4 is the only phase needing real ops capacity; do not
  pull it forward.
- Regulatory drift: any future move toward real-money staked formats is
  partner-license only, or it doesn't happen.
- Payment-rail fragility in NG: keep Paystack product categories clean
  (education/software), never gaming.
