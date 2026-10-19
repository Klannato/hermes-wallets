# hermes-wallets

A Hermes desktop pane that shows what your AI wallets are actually doing: Nous Portal and Vercel AI Gateway balances, live spend rate, runway, which wallet is billing the chat you're looking at, and a price-aware model shortlist.


## What it shows

**Wallets** — one card per account:

| Row | Meaning |
|---|---|
| balance | Current credits, straight from the provider |
| top-up / plan | Purchased credits vs subscription credits (Nous splits these) |
| spent this month | Calendar-month spend against your cap |
| lifetime used | Cumulative AI Gateway spend on this key (Vercel only) |
| spent last 24h / 7d | Measured from sampled balances, not estimated |
| spend rate | `$/hr · $/day`, averaged over the sampling window |
| spent per minute | same window ÷ 60 |
| runway at this rate | balance ÷ measured rate |
| **+ add credit** | opens that wallet's top-up surface in your browser |

The `● in use` badge and accent border mark the wallet that is billing **the chat you are currently looking at** — not the profile default. A composer model pick beats config for one session, and this widget reads the session's live route, so the dot follows the chat.

**Model picks** — five price bands (dirt cheap → frontier), best price-for-capability in each:

- **Spectrum bar** — red → yellow → green, with a tick for the model. Capability rank minus price rank, so "green" means cheap *for its class*.
- **Thin bar + ratio** — price against the median chat model on the gateway, log scale, centre tick at the median.
- **`▼NN% on Nous` / `▼NN% on Vercel`** — which wallet carries a marked-down price. Nous publishes a real compare-at price (`pricing.original`); Vercel has none, so its discount is measured against the vendor's list price.
- **`cheaper on X`** — lower absolute price at a 3:1 input:output blend, discount or not.
- **`peak ×2 until HH:MMZ`** — models with time-of-day pricing (DeepSeek family): the gateway publishes the windows, so the widget says when you're paying double.

Both "model picks" and "on sale" collapse, and the collapsed state persists.

## Install

The package has an agent half (Python backend routes) and a desktop half (the pane). Clone it into your plugin root:

```bash
git clone https://github.com/Klannato/hermes-wallets ~/.hermes/plugins/wallets
hermes plugins enable wallets
```

Then load the desktop half. Two ways, and they behave differently:

1. **App root (recommended for trying it):** copy the pane into the desktop plugin root —
   ```bash
   mkdir -p ~/.hermes/desktop-plugins/wallets
   cp ~/.hermes/plugins/wallets/desktop/plugin.js ~/.hermes/desktop-plugins/wallets/plugin.js
   ```
   A folder without a `.hermes-package.json` marker loads **enabled**.

2. **Leave it in the package:** the app copies `plugins/wallets/desktop/` into the app root and stamps a marker, which makes the pane **opt-in** — enable it in Settings → Capabilities → Plugins.

The Python half only imports when the plugin is in `plugins.enabled` in `config.yaml` (that's the security boundary, not a preference). Backend route changes need an app restart: mounted `/api/plugins/wallets` routes are never re-imported in place.

## Requirements

- Hermes desktop app (the pane is a desktop plugin; CLI/TUI don't render it).
- **Nous**: `hermes portal login` — the backend reuses Hermes' own OAuth token and billing client, including refresh.
- **Vercel AI Gateway**: `AI_GATEWAY_API_KEY` in `$HERMES_HOME/.env`.

Either wallet works alone; the missing one shows an error line instead of breaking the pane.

## Data sources

| Source | Used for |
|---|---|
| `GET https://ai-gateway.vercel.sh/v1/credits` | Vercel balance + lifetime spend |
| `GET https://ai-gateway.vercel.sh/v1/models` | prices, context, tags, peak windows (cached 6 h) |
| `hermes_cli.nous_billing.get_billing_state()` | Nous balance, monthly cap, purchase bounds |
| `hermes_cli.nous_account.get_nous_portal_account_info()` | subscription vs top-up split |
| `GET https://inference-api.nousresearch.com/v1/models` | Nous per-model prices + compare-at (cached 6 h) |
| `models.dev` cache (already on disk) | vendor list prices for the Vercel-side discount |

Balance samples are appended to `$HERMES_HOME/state/wallets-history.json` every 5 minutes while the pane is open; that file is what makes spend rate and runway measurements rather than guesses. Nothing leaves your machine: no telemetry, no analytics, and the widget never sends your balances anywhere.

## Honest limitations

- **The spectrum is not a benchmark.** The gateway publishes no scores, so capability is inferred from declared tags (reasoning, tool use, vision, structured output) plus context size, then compared against price rank. It ranks bargains; it cannot tell you a cheap model is bad at your specific job.
- **`cheaper on X` uses a 3:1 input:output blend.** Change the mix and the winner can flip — an input-heavy workload and an output-heavy one disagree.
- **"vs list" can lag.** List prices come from models.dev; a vendor price change shows up there later.
- **Peak pricing is real money.** DeepSeek-family models double inside published UTC windows; the widget shows the window but doesn't avoid it for you.
- **Runway is balance ÷ measured rate.** Idle for an hour and it flattens; it is a projection, not a promise.

## Development

`dev/render-check.mjs` renders the real `desktop/plugin.js` to static HTML against a stubbed SDK and asserts the pane's structure — no app, no browser, no network:

```bash
cd dev && node render-check.mjs
```

It expects `react` and `react-dom` to resolve; run it from inside the Hermes desktop app folder (`apps/desktop`) or any project that has them installed.

## License

MIT — see LICENSE.
