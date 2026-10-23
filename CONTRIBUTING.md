# Contributing to MicoPay

MicoPay is participating in **[Stellar Drips Wave 8](https://www.drips.network/wave/stellar)**. Contributions are scoped to the retail mobile app — not the whole monorepo.

> **Two campaigns run in parallel.** This guide covers Stellar Drips issues (`wave:*` + `Stellar Wave` labels). Issues labeled `grantfox:*` belong to the **GrantFox** campaign — same code standards, different assignment and reward flow: see [`docs/GRANTFOX_GUIDE.md`](./docs/GRANTFOX_GUIDE.md). Every issue belongs to exactly one campaign.

> Before opening a PR, skim this file end to end. It is the contract we review PRs against.

---

## Wave focus

One flow over many demos. The Wave is organized around making **Core Retail Flow** — trade creation, state, cancel, timeout, refund, receipt — work reliably end to end.

Every other milestone exists to make that flow trustworthy. If you are unsure where to start, pick an issue from [**Wave 8: Core Retail Flow (P0)**](https://github.com/Micopay/micopay-protocol/milestone/24) first.

---

## In-scope paths

- `micopay/frontend/` — retail mobile app (React/Vite, port 5181)
- `micopay/backend/` — retail backend (Node/Fastify, port 3002)
- `docs/` — shared product, UX, and team guides

## Out-of-scope unless an issue explicitly opens it

- `apps/api/` (agent x402 protocol API)
- `apps/web/` (protocol dashboard)
- `contracts/` (Soroban contracts)
- `stitch_remix_of_micopay/`, old prototypes, deployment configs, and operations internals

PRs that touch out-of-scope paths will be asked to split or rescope.

---

## Getting started

1. Fork the repo and clone your fork.
2. Install dependencies from the repo root:
   ```bash
   npm install
   ```
3. Run the retail app locally (two terminals):
   ```bash
   cd micopay/backend && npm run dev   # http://localhost:3002
   cd micopay/frontend && npm run dev  # http://localhost:5181
   ```
4. Read the four core docs before picking an issue:
   - [`docs/PRODUCT_SCOPE.md`](./docs/PRODUCT_SCOPE.md) — what we are building and why
   - [`docs/RETAIL_ROADMAP.md`](./docs/RETAIL_ROADMAP.md) — the phased execution plan
   - [`docs/UX_MANIFESTO.md`](./docs/UX_MANIFESTO.md) — the trust and UX bar every PR is reviewed against
   - [`docs/DRIPS_TEAM_GUIDE.md`](./docs/DRIPS_TEAM_GUIDE.md) — how issues, reviews, and merges work during the Wave
5. Pick an issue from the [open milestones](https://github.com/Micopay/micopay-protocol/milestones).

---

## Working with Claude Code

If you use [Claude Code](https://claude.com/claude-code), this repo ships skills in
[`.claude/skills/`](./.claude/skills/README.md) so the assistant follows the same rules we review against:

| Skill | What it does |
|---|---|
| `micopay-reglas` | Code rules: security, money, Stellar key, i18n, icons, commits, tests |
| `micopay-resolver-issue` | Takes an issue to a PR: branch, code, tests, verification (`/micopay-resolver-issue 448`) |
| `micopay-verificar` | Checks your branch before pushing and labels each failing test |
| `stellar-dev` | General Stellar and Soroban guide |

You don't need Claude to use the verifier. Run it before every PR:

```bash
.claude/skills/micopay-verificar/verify.sh
```

Full guide: [`.claude/skills/README.md`](./.claude/skills/README.md).
Not to be confused with [`skill/SKILL.md`](./skill/SKILL.md), which describes the MicoPay API for external agents.

---

## Picking an issue

- Look for issues labeled [`wave:good-first`](https://github.com/Micopay/micopay-protocol/labels/wave%3Agood-first) if it is your first PR.
- Comment on the issue asking to be assigned **before** you start work. We assign one contributor per issue to avoid duplicated effort.
- If nobody responds within 48 hours, tag the maintainer on the issue.
- Do not open PRs against issues labeled `wave:blocked` or `wave:needs-product` until the block is cleared.

## Labels we use

- **Wave surface:** `wave:retail`, `wave:frontend`, `wave:backend`, `wave:merchant`, `wave:trust`, `wave:docs`
- **Complexity:** `complexity: low`, `complexity: medium`, `complexity: high`
- **Flow control:** `wave:good-first`, `wave:blocked`, `wave:needs-product`
- **Rewards:** `Stellar Wave` marks work eligible for Drips

---

## Milestones

These are the milestones for the current Wave. Milestones from earlier Waves stay open for
historical reference — pick from the Wave 8 ones.

| Milestone | Focus |
|---|---|
| [Wave 8: Core Retail Flow (P0)](https://github.com/Micopay/micopay-protocol/milestone/24) | **Wave priority.** Trade creation, detail view, state machine UX, cancel / timeout / refund, receipts, history linked to real states |
| [Wave 8: UI Truth (P1)](https://github.com/Micopay/micopay-protocol/milestone/25) | Places where the UI misrepresents real data or offers controls that do nothing |
| [Wave 8: Backend Hardening](https://github.com/Micopay/micopay-protocol/milestone/26) | Auth persistence, audit log, error taxonomy, rate limiting, replay protection, structured logging |
| [Wave 8: Product & Release](https://github.com/Micopay/micopay-protocol/milestone/27) | Build config, test suite, store readiness, privacy and support paths |
| [Wave 8: Market & User Validation](https://github.com/Micopay/micopay-protocol/milestone/28) | Research issues. Delivered by PR adding your section to `docs/VALIDATION_DRIPS.md`, first person, one assignee per issue |

---

## What a good PR looks like

- Solves the issue as scoped (no side quests)
- Does not touch out-of-scope paths
- Matches the tone of [`docs/UX_MANIFESTO.md`](./docs/UX_MANIFESTO.md) for anything user-facing
- Includes local test notes when behavior changes (what you ran, what you saw)
- Stays under the complexity tier declared on the issue
- References the issue number in the PR description (`Closes #123`)

Review SLA during the Wave: **first review within 24 hours**.

### Commit and PR style

- Keep commits focused. One logical change per commit is ideal.
- PR title: short, imperative mood (`fix: empty state on history`, not `Fixed the empty state`).
- PR description should answer: what changed, why, how to test, and which issue it closes.

---

## Rewards

Rewards are distributed by [Drips](https://www.drips.network/wave/stellar) — not by the MicoPay maintainers — as a proportional share of the Wave 8 reward pool funded by the Stellar Development Foundation.

Points per issue are fixed by Drips based on the `complexity` label set on the issue:

| Complexity label | Points | Typical work |
|---|---:|---|
| `complexity: low` | 100 | Typos, empty states, small copy fixes, tiny tests |
| `complexity: medium` | 150 | Self-contained screen, endpoint, state handling, validation |
| `complexity: high` | 200 | Complex features, refactors, or new integrations |

Your final payout = (your points ÷ total points earned across all contributors in the Wave) × Wave 8 reward pool. Only issues labeled `Stellar Wave` count. See [Drips' contributor guide](https://docs.drips.network/wave/contributors/solving-issues-and-earning-rewards/) for details on withdrawals and timing.

### Before you apply

Drips requires **identity verification (KYC) through Sumsub before you can apply to any issue** — government ID, a selfie, and proof of address. This is Drips' requirement, not MicoPay's, and we have no say in it. Do it before you pick an issue so you are not blocked once you are ready to work.

Two other limits set by Drips: you can have at most **15 pending applications** at a time, and points land only when the maintainer marks the issue resolved after your PR is merged — not when the issue is assigned to you.

---

## Code of Conduct

Be direct, be kind, and assume good intent. Disrespectful behavior in issues, PRs, or reviews is grounds for removal from the Wave.

## Getting help

- **Unclear issue scope?** Comment on the issue.
- **Blocked on a product decision?** Tag the maintainer and add the `wave:needs-product` label.
- **General questions about the Wave?** Check [`docs/DRIPS_TEAM_GUIDE.md`](./docs/DRIPS_TEAM_GUIDE.md) first.
