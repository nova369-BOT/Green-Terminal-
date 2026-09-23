# Plan — rebuild EdgeDepth-style orderflow + footprint (from clean lse-terminal)

**Status: awaiting your approval. Nothing is deleted or changed yet.**

## 0. Goal

A **working orderflow + footprint** experience **the way EdgeDepth does it**, built
step by step on a **clean** `flatmoonsociety/lse-terminal` baseline — not a patchwork
of the previous attempt.

Success = you can open the terminal, see a live book / tape / footprint that behaves
like EdgeDepth’s pipeline (same wire contract, same stream semantics), verified
end-to-end — not “implemented and looks done”.

---

## 1. Step 0 — Wipe to clean baseline (after you approve)

**Target tree = git commit `80ef5b5`** (pure lse-terminal import, **no orderflow**).

| Remove (my work) | Keep |
|---|---|
| `lse_terminal/orderflow/**` | Entire lse-terminal app from `80ef5b5` |
| `lse_terminal/ui/static/orderflow.js` | `frontend/` chart stack from baseline |
| `tests/test_orderflow.py` | Baseline `tests/` |
| Orderflow wiring + UI diffs in `server.py`, `index.html`, `app.js`, `style.css`, `chart.js`, `mount.tsx` | `.git` history (untouched) |
| `render.yaml`, `.python-version`, README deploy section | Repo itself (not deleted/closed) |

Method: `git reset --hard 80ef5b5` on branch `arena/01a0caa0-green-terminal`  
(working tree only in effect; history remains; **no push of the wipe until you confirm the new work** — or we push the wipe as its own commit first if you prefer a clean remote tip; **default: wipe locally, push only when step 1 is green**).

**Verify step 0:** app boots (`lset`), baseline pytest suite green, no `orderflow` paths remain.

---

## 2. Source of truth — both EdgeDepth repos (re-cloned)

Already re-cloned this session:

- `/home/user/edgedepth-gateway` — Go feed → **protobuf over WS**
- `/home/user/edgedepth-terminal` — C++/WASM terminal (DOM, tape, heatmap, **footprint**)

**Before any implementation code**, full read of:

| Area | Gateway | Terminal |
|---|---|---|
| Wire contract | `proto/edgedepth.proto` | `protos/messages.proto` (**field numbers must match**) |
| Hub / fan-out | `internal/hub/hub.go`, `client.go` | `src/core/websocket.*`, `stream_handler.*` |
| Book / tape | `internal/binance/feed.go` (depth, aggTrade) | `orderbook_manager.*`, `trades_widget.*` |
| **Footprint** | `internal/volume/history.go` (closed minutes, POC/VA 70%) | `footprint_manager.*`, `footprint_transport.*`, tests |
| Heatmap / RT depth | — | `heatmap_manager.*`, `docs/REALTIME_DEPTH.md` |
| Control plane | JSON `method` subscribe / get_* | client subscribe shape |

Standing rule from earlier agreement: **read every file/line of both repos before implementing.**

---

## 3. Architecture (what we rebuild, in EdgeDepth shape)

```
[LSE providers / demo tape]     ← data lives in the existing app
        │
        ▼
  orderflow core (Python)       ← one engine: book + tape + closed-minute volume
        │
        ├─ REST/JSON WS  → LSE ORDERFLOW page (DOM, tape, footprint UI)
        └─ binary /edge/ws → WSPayload frames (EdgeDepth wire)
```

Mirror of EdgeDepth:

| EdgeDepth | Our rebuild |
|---|---|
| Gateway hub | One process-local **orderflow hub** inside LSE server |
| Streams 1 / 3 / 17 / 26 | Same stream ids, same inner messages |
| JSON control `method: subscribe` | Same control plane on binary WS |
| Closed observed minutes → stream 17 | **Footprint**: same minute buckets, buy/sell levels, POC/VA |
| Client queue 1024 frames / 16 MiB | Same budgets; slow client disconnected |
| No length prefix; plain protobuf | Byte-identical envelope rules |

**Explicit non-goals for this rebuild (unless you add them later):** Binance live
connector (blocked in this sandbox), C++/WASM port of their UI, replay `.edpack`,
hosted-only VPIN/scanner.

---

## 4. Build steps (each step: implement → verify → report → stop for “go”)

You chose **plan first, then build**. After you approve this plan, steps run one at a time
with a short report; next step starts only after you say continue (or you say “run through”).

| # | Step | Done when |
|---|---|---|
| **0** | Wipe to `80ef5b5` | Clean tree; baseline tests pass; no orderflow files |
| **1** | Full read of both EdgeDepth repos → **contract sheet** (streams, message fields, control methods, footprint minute rules, budgets) | You get the contract sheet as a file in the repo (`docs/orderflow-contract.md` or similar); no app code yet |
| **2** | **Core engine** (book, tape, closed-minute volume, POC/VA) + unit tests | Tests green; pure Python; no HTTP yet |
| **3** | **REST + JSON WS** for the page (book, trades, footprint minutes, status) | curl + WS against live server; numbers real |
| **4** | **Binary `/edge/ws`** — WSPayload, subscribe/unsubscribe, get_footprint_history, budgets | Decode with the **same** rules as EdgeDepth (wire_shape-style test); no silent field mismatch |
| **5** | **ORDERFLOW UI** in LSE (DOM ladder, tape, **footprint** grid + imbalance controls as EdgeDepth describes) | Open MARKETS → ORDERFLOW in browser; live updates; footprint cells match API |
| **6** | **Chart heatmap / RT depth wiring** (optional same pass as 5 if you want it) | ProChart depth layer fed from same hub (no second subsystem) |
| **7** | **End-to-end proof** | Full suite + live battery: health, book, tape, footprint history, WS frames, UI screenshot-level check; section-23 style report |

Order is fixed: **contract before code; core before wire; wire before UI.**

---

## 5. Master protocol still applies (77)

- End-to-end verify every step — no fake success  
- One pipeline — no duplicated orderflow subsystems  
- Preserve existing LSE functionality  
- Report per section-23 format at delivery  

---

## 6. What I need from you

1. **Approve this plan** (or correct a step / baseline).  
2. Confirm wipe style: **local reset now, push later** (default) **or** push wipe immediately as its own commit.  
3. Say **“one step at a time”** or **“run through after each report without waiting”** — default is wait for your “go” after each numbered step.

**Nothing is deleted until you reply with approval.**
