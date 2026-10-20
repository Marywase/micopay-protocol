# micopay/frontend

React 19 + Vite SPA for the MicoPay retail mobile app. Implements the user-facing flows for converting digital assets to cash and depositing cash into digital assets through nearby agents, using Stellar HTLC escrow as the settlement layer.

---

## Quick start

```sh
cd micopay/frontend
cp .env.example .env   # edit if your backend runs on a different port
npm install
npm run dev            # http://localhost:5181
```

> Requires Node >=20 (root `package.json` engines field). Run `node --version` to check.

| Script | Command | Output |
|--------|---------|--------|
| `dev` | `vite` | Dev server on port **5181** (strict — will not increment) |
| `build` | `tsc && vite build` | Type-check + bundle → `dist/` |
| `preview` | `vite preview` | Serve `dist/` locally |

Deploy target: Vercel. `vercel.json` rewrites all paths to `index.html`.

---

## Environment Variables

Copy `.env.example` to `.env` before starting. Both variables default to `localhost:3000` when unset.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_URL` | `http://localhost:3000` | Base URL for the backend REST API — trades, users, DeFi. `CONTRIBUTING.md` documents the backend on port **3002**; update this when running the full stack. |
| `VITE_PROTOCOL_API_URL` | `http://localhost:3000` | Base URL used by `ClaimQR.tsx` to poll merchant cash requests. Separated to allow independent deployment of the protocol service. |

---

## Pages Map

The app uses a manual state machine in `App.tsx` (`useState`), not React Router. There are no URL-based routes except `ClaimQR`.

| State key | Component | Purpose |
|-----------|-----------|---------|
| `home` | `Home.tsx` | Wallet dashboard — Stellar balance, trade history, main CTAs |
| `cashout` | `CashoutRequest.tsx` | Amount entry — cash-out flow |
| `deposit` | `DepositRequest.tsx` | Amount entry — deposit flow |
| `map` | `ExploreMap.tsx` | Agent map — cash-out offer selection |
| `map_deposit` | `DepositMap.tsx` | Agent map — deposit offer selection |
| `chat` | `ChatRoom.tsx` | Escrow chat with agent (cash-out) |
| `chat_deposit` | `DepositChat.tsx` | Escrow chat with agent (deposit) |
| `qr_reveal` | `QRReveal.tsx` | HTLC secret QR display + trade completion |
| `qr_deposit` | `DepositQR.tsx` | Deposit confirmation QR |
| `success` | `SuccessScreen.tsx` | Post-trade confirmation |
| `explore` | `Explore.tsx` | DeFi product discovery |
| `cetes` | `CETESScreen.tsx` | Tokenized CETES bonds — buy/sell |
| `blend` | `BlendScreen.tsx` | Blend Capital — supply/borrow |
| _(standalone)_ | `ClaimQR.tsx` | Merchant-facing QR claim page. Not in the SPA router. Requires a direct URL with a `requestId` prop. |

---

## Flow Intent

### Production-intent — blockchain wired

These paths hit the backend and produce on-chain state on Stellar Testnet:

- **Trade lifecycle** — `createTrade → lockTrade → revealTrade → completeTrade` via `src/services/api.ts`.
- **HTLC secret QR** — `QRReveal.tsx` fetches the real preimage from `GET /trades/:id/secret` and encodes it into the QR payload.
- **`lock_tx_hash`** — stored in component state, surfaced in trade history with Stellar Explorer links. Filtered: hashes prefixed with `mock` are not linked.
- **Wallet balance** — `Home.tsx` fetches live XLM balance from `GET /account/balance` on mount.
- **Trade history** — fetched from `GET /trades/history` when a user token is present.
- **`ClaimQR.tsx`** — polls `GET /api/v1/cash/request/:id` on a 4-second interval with a live countdown timer.

### Demo-only — confirmed mocks

These flows render UI but produce no on-chain state:

- **Agent maps** (`ExploreMap`, `DepositMap`) — static marker PNGs rendered by `src/components/MapSim.tsx`. Assets live in `public/`: `mushroom_red.png` (Farmacia Guadalupe), `mushroom_green.png` (@carlos_g / Don Pepe), `mushroom_gold.png` (Centro Lavado), `map_bg.png` (background). No real P2P matching; the three merchants are hardcoded fixtures.
- **Agent names** — `"Farmacia Guadalupe"` and `"Tienda Don Pepe"` are hardcoded strings in `QRReveal.tsx` and `SuccessScreen.tsx`.
- **CETES buy/sell** — backend returns `{ simulated: true }`. No Etherfuse tokens are issued and no on-chain swap executes.
- **Blend supply/borrow** — backend returns `{ simulated: true }`. No Blend Capital pool interaction occurs.
- **XLM → MXN rate** — hardcoded at `20 MXN / 1 XLM` in `Home.tsx:45`. Not sourced from an oracle or exchange.
- **QR fallback** — when the backend is unreachable, `QRReveal.tsx` renders the static payload `MICOPAY:DEMO:mock_secret_for_ui_preview`.
- **User identity** — auto-registered on first load with a random username (`juan_<ts>`, `farmacia_<ts>`). Persisted in `localStorage`. No real authentication.
- **Stellar address** — generated client-side by `randomAddress()` in `api.ts:12`. Not a real keypair; not funded.

---

## How to contribute

Read [`CONTRIBUTING.md`](../../CONTRIBUTING.md) before opening a PR. The Drips Wave 4 scope is limited to:

- `micopay/frontend/` — this app
- `micopay/backend/` — the backend it calls

Start from the [Core Retail Flow milestone](https://github.com/ericmt-98/micopay-protocol/milestone/2). Every other milestone exists to make that flow trustworthy.

---

## Known Limitations

1. **No browser history.** `App.tsx` does not push to `window.history`. Back/forward navigation and deep links do not work.
2. **No wallet integration.** Stellar addresses are generated client-side. Freighter and other wallets are not connected.
3. **No MXNe.** The wallet holds XLM, USDC and CETES; the MXNe placeholder row was removed.
4. **`ClaimQR` is not routable from the SPA.** No internal navigation path leads to it; it requires a direct URL.
5. **CETES and Blend are fully simulated.** All DeFi transactions return mock hashes. No on-chain activity is triggered.
6. **XLM rate is a static mock.** `20 MXN / 1 XLM` is a hardcoded demo constant — not a live feed.
7. **Port mismatch.** `CONTRIBUTING.md` documents the backend on port `3002`. Both env vars default to `3000`. Override in `.env` when running the full stack.
