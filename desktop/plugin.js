/**
 * Wallets — Nous Portal + Vercel AI Gateway balances, monthly spend, burn rate,
 * and which of the two is actually being charged right now.
 *
 * Desktop half of the `wallets` package: ship it as desktop/plugin.js inside the
 * plugin folder, or copy it to ~/.hermes/desktop-plugins/wallets/plugin.js
 * (marker-less, so it loads enabled). Data comes from the package's own
 * plugin_api.py via ctx.rest('/state'); the focused chat's session id rides
 * along so the backend can report that chat's real provider (a composer pick
 * beats profile config for a single session).
 */

import { cn, haptic, host, useQuery, useValue } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'wallets'
const REFRESH_MS = 60_000

// Handles captured from register(ctx); module scope so the chip and pane share one backend door.
let rest = null
let osDoor = null
let storage = null
/** GET/POST against this plugin's own backend namespace (/api/plugins/wallets). */
const api = (path, opts) => (rest ? rest(path, opts) : Promise.reject(new Error('backend unavailable')))

/** Open a provider page in the user's browser. Routed through ctx.os so the
 *  plugin stays attributed and the app never navigates itself. */
const openUrl = (url) => {
  if (!url) return
  if (osDoor && osDoor.openExternal) osDoor.openExternal(url)
}

/** `$1,234.56`; an em dash for anything unparseable, so a partial payload
 *  reads as "missing" instead of "$0.00". */
const money = (v) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? '—'
    : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Status-bar form: `$1.2k` above a thousand, two decimals below. */
const compact = (v) => {
  const n = Number(v || 0)
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

/** One poll shared by pane + chip, keyed by the focused chat so the "in use"
 *  badge follows tab focus instead of lagging a cache window behind. */
function useWallets() {
  const sessionId = useValue(host.state.focusedSessionId)
  const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
  const query = useQuery({
    queryKey: [ID, 'state', sessionId || ''],
    queryFn: () => api(`/state${qs}`),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1
  })
  return { ...query, sessionId }
}

/** Query string for a forced refresh, keeping the focused chat's id attached
 *  so the response still describes THIS chat's billing route. */
const forceQs = (sessionId) =>
  sessionId ? `?force=true&session_id=${encodeURIComponent(sessionId)}` : '?force=true'

function RoleBadge({ role }) {
  if (!role) return null
  const active = role === 'active'
  return jsxs('span', {
    className: 'inline-flex items-center gap-1 text-[0.5625rem] font-medium uppercase tracking-wide',
    style: { color: active ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)' },
    children: [
      active
        ? jsx('span', {
            style: {
              width: 5,
              height: 5,
              borderRadius: 9999,
              background: 'var(--ui-accent)',
              display: 'inline-block'
            }
          })
        : null,
      active ? 'in use' : role
    ]
  })
}

/** "Add credit" — opens that wallet's own top-up surface in the browser.
 *  Nous accepts the topup=open query param; Vercel's balance button lives on
 *  the AI Gateway dashboard page, which its deep link lands on. */
function CreditLink({ topUp }) {
  if (!topUp || !topUp.url) return null
  const min = topUp.minUsd ? ` · min $${Number(topUp.minUsd).toFixed(0)}` : ''
  return jsxs('button', {
    type: 'button',
    className: cn(
      'mt-0.5 flex w-full items-center justify-between gap-2 rounded px-1 py-1',
      'hover:bg-(--chrome-action-hover)'
    ),
    style: { borderTop: '1px dashed var(--ui-stroke-secondary)' },
    title: `${topUp.url}${min ? `  (minimum $${Number(topUp.minUsd).toFixed(0)})` : ''}`,
    onClick: () => {
      haptic('tap')
      openUrl(topUp.url)
    },
    children: [
      jsx('span', { className: 'text-[0.625rem]', style: { color: 'var(--ui-accent)' }, children: '+ add credit' }),
      jsx('span', { className: 'text-[0.5rem]', style: { color: 'var(--ui-text-quaternary)' }, children: `opens billing${min}` })
    ]
  })
}

function Row({ label, value, title }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-2 text-[0.6875rem]',
    title,
    children: [
      jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: label }),
      jsx('span', { style: { color: 'var(--ui-text-secondary)' }, children: value })
    ]
  })
}

/** One wallet. Foldable per card, because a pane can now hold any number of
 *  them: the header keeps the balance visible while folded, so a collapsed
 *  wallet still answers "how much is left". */
function WalletCard({ w }) {
  const failed = !w.ok
  const active = w.role === 'active'
  // Wallets with a real balance start open; balance-less ones start folded so
  // they don't push the ones you can act on below the fold.
  const [open, toggle] = useCollapsed(`wallet:${w.id}`, Boolean(w.hasBalance))
  const depleted = Boolean(w.depleted)
  const summary = failed ? (w.hasBalance ? 'unavailable' : 'no balance API') : money(w.balance)

  return jsxs('div', {
    className: 'flex flex-col gap-1.5 rounded-md p-2.5',
    style: { border: `1px solid ${active ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
    children: [
      jsxs('button', {
        type: 'button',
        className: cn(
          'flex w-full items-center justify-between gap-2 rounded text-left',
          'hover:bg-(--chrome-action-hover)'
        ),
        title: open ? `Fold ${w.name}` : `Unfold ${w.name}`,
        onClick: toggle,
        children: [
          jsxs('span', {
            className: 'flex min-w-0 items-center gap-1',
            children: [
              jsx('span', {
                className: 'text-[0.5rem]',
                style: { color: 'var(--ui-text-quaternary)', flex: '0 0 auto' },
                children: open ? '▾' : '▸'
              }),
              jsx('span', {
                className: 'truncate text-[0.6875rem] font-medium uppercase tracking-wide',
                style: { color: 'var(--ui-text-tertiary)' },
                children: w.name
              })
            ]
          }),
          jsxs('span', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx(RoleBadge, { role: w.role }),
              // Folded, the card still shows what it is worth.
              open
                ? null
                : jsx('span', {
                    className: 'tabular-nums text-[0.625rem]',
                    style: { color: 'var(--ui-text-secondary)', flex: '0 0 auto' },
                    children: summary
                  })
            ]
          })
        ]
      }),
      // A wallet with no balance API exists to tell you where to buy credits,
      // so its link stays visible while the card is folded.
      !open && w.topUp ? jsx(CreditLink, { topUp: w.topUp }) : null,
      open
        ? jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsxs('div', {
                className: 'flex items-baseline gap-1.5',
                children: [
                  jsx('div', {
                    className: 'text-[1.375rem] font-semibold leading-none tabular-nums',
                    children: failed ? '—' : money(w.balance)
                  }),
                  depleted
                    ? jsx('span', {
                        className: 'text-[0.5625rem] uppercase tracking-wide',
                        style: { color: 'var(--ui-orange)' },
                        title: w.rawBalance !== null && w.rawBalance !== undefined
                          ? `Provider reports ${w.rawBalance.toFixed(4)}: spent out`
                          : 'spent out',
                        children: 'empty'
                      })
                    : null
                ]
              }),
              failed
                ? jsx('div', {
                    className: 'text-[0.6875rem] leading-snug',
                    style: { color: 'var(--ui-text-quaternary)' },
                    children: w.error || w.note || 'unavailable'
                  })
                : jsxs('div', {
                    className: 'flex flex-col gap-1',
                    children: [
                      w.subscriptionUsd || w.purchasedUsd
                        ? jsx(Row, {
                            label: 'top-up / plan',
                            value: `${money(w.purchasedUsd || 0)} / ${money(w.subscriptionUsd || 0)}`,
                            title: 'Purchased credits / subscription credits'
                          })
                        : null,
                      w.monthSpent !== null && w.monthSpent !== undefined
                        ? jsx(Row, {
                            label: 'spent this month',
                            value: w.monthSpent > 0 ? money(w.monthSpent) : 'none yet',
                            title: w.monthCap ? `Monthly cap ${money(w.monthCap)}` : 'Spend this calendar month'
                          })
                        : null,
                      w.totalUsed !== null && w.totalUsed !== undefined
                        ? jsx(Row, {
                            label: 'lifetime used',
                            value: money(w.totalUsed),
                            title: 'Cumulative spend recorded by the provider'
                          })
                        : null,
                      jsx(Row, {
                        label: 'spent last 24h / 7d',
                        value: `${w.spent24h === null || w.spent24h === undefined ? '—' : money(w.spent24h)} / ${
                          w.spent7d === null || w.spent7d === undefined ? '—' : money(w.spent7d)
                        }`,
                        title: 'Measured spend over the last 24 hours and 7 days, from sampled balances'
                      }),
                      w.burn
                        ? jsx(Row, {
                            label: 'spend rate',
                            value: `${money(w.burn.perHour)}/hr · ${money(w.burn.perDay)}/day`,
                            title: `Averaged over the last ${w.burn.windowMin} min (${w.burn.samples} balance samples)`
                          })
                        : jsx(Row, {
                            label: 'spend rate',
                            value: 'measuring…',
                            title: 'Needs two balance samples at least 5 minutes apart — the pane samples every 5 min while open'
                          }),
                      w.burn && w.burn.perHour
                        ? jsx(Row, {
                            label: 'spent per minute',
                            value: `$${(w.burn.perHour / 60).toFixed(4)}/min`,
                            title: 'Same window as the spend rate, divided by 60'
                          })
                        : null,
                      w.runwayDays !== null && w.runwayDays !== undefined
                        ? jsx(Row, {
                            label: 'runway at this rate',
                            value:
                              w.runwayDays >= 1
                                ? `${w.runwayDays} days`
                                : `${w.runwayHours !== null && w.runwayHours !== undefined ? w.runwayHours : Math.round(w.runwayDays * 24)} hours`,
                            title: 'Current balance divided by the per-day spend rate — a projection, not a promise'
                          })
                        : null,
                      w.keyHint || w.tier
                        ? jsx('div', {
                            className: 'text-[0.625rem]',
                            style: { color: 'var(--ui-text-quaternary)' },
                            children: [w.keyHint ? `key ${w.keyHint}` : null, w.tier ? `tier ${w.tier}` : null]
                              .filter(Boolean)
                              .join(' · ')
                          })
                        : null
                    ]
                  }),
              jsx(CreditLink, { topUp: w.topUp })
            ]
          })
        : null
    ]
  })
}

const GRADE_COLOR = {
  good: 'var(--ui-green)',
  fair: 'var(--ui-yellow)',
  premium: 'var(--ui-red)'
}

/** Price/performance as a spectrum: the track runs red (expensive for what it
 *  can do) through yellow (middle) to green (cheap for what it can do), and the
 *  tick marks where this model sits. `value` is capability rank minus price
 *  rank, so 0 = exactly middle of the catalogue. */
function Spectrum({ value, grade }) {
  const v = Number(value)
  if (!Number.isFinite(v)) return null
  // -0.5 .. +0.8 maps across the track; outside that we just clamp to an end.
  const pos = Math.max(0, Math.min(100, ((v + 0.5) / 1.3) * 100))
  return jsxs('div', {
    className: 'flex items-center gap-1.5',
    title: `price/performance ${v >= 0 ? '+' : ''}${v.toFixed(2)} — capability rank minus price rank (0 = middle of the catalogue)`,
    children: [
      jsxs('div', {
        style: {
          position: 'relative',
          height: 5,
          flex: '1 1 auto',
          borderRadius: 3,
          background:
            'linear-gradient(90deg, var(--ui-red) 0%, var(--ui-yellow) 50%, var(--ui-green) 100%)',
          opacity: 0.85
        },
        children: [
          jsx('div', {
            style: {
              position: 'absolute',
              left: `calc(${pos}% - 1.5px)`,
              top: -2,
              width: 3,
              height: 9,
              borderRadius: 1,
              background: 'var(--ui-text-primary)',
              boxShadow: '0 0 0 1px var(--ui-bg-editor)'
            }
          })
        ]
      }),
      jsx('span', {
        style: {
          fontSize: '0.5625rem',
          flex: '0 0 auto',
          color: GRADE_COLOR[grade] || 'var(--ui-text-tertiary)'
        },
        children: grade
      })
    ]
  })
}

/** A discount against the vendor's list price (models.dev), when there is one.
 *  Names the vendor: the same model id is served by several upstreams, and the
 *  discount is only meaningful next to whose list price it beats. */
const WALLET_LABEL = { nous: 'Nous', vercel: 'Vercel' }

/** Which WALLET carries the discount — the only thing that matters at the till.
 *  Nous reports its own compare-at price (`pricing.original`); Vercel has none,
 *  so its discount is measured against the vendor list price instead. */
function SaleTag({ sale }) {
  if (!sale) return null
  const wallet = WALLET_LABEL[sale.wallet] || 'list'
  return jsx('span', {
    className: 'text-[0.5625rem]',
    style: { color: 'var(--ui-green)', flex: '0 0 auto' },
    title: `Pay with the ${wallet} wallet: ${sale.pct}% below the $${Number(sale.list).toFixed(2)}/Mtok list price`,
    children: `▼${sale.pct}% on ${wallet}`
  })
}

/** The wallet with the lower price for this model (blank when they tie or the
 *  model only exists on one side). */
function CheaperTag({ wallet }) {
  if (!wallet) return null
  const label = WALLET_LABEL[wallet] || wallet
  return jsx('span', {
    className: 'text-[0.5625rem]',
    style: { color: 'var(--ui-text-quaternary)', flex: '0 0 auto' },
    title: `Cheaper with the ${label} wallet`,
    children: `cheaper on ${label}`
  })
}

/** Off-peak / peak status for models that publish a peak multiplier. */
function PeakTag({ peak }) {
  if (!peak || !peak.multiplier) return null
  const on = Boolean(peak.inPeak)
  const text = on
    ? `peak ×${peak.multiplier} until ${peak.until}Z`
    : peak.startsInMin
      ? `off-peak · peak in ${peak.startsInMin >= 60 ? `${Math.round(peak.startsInMin / 60)}h` : `${peak.startsInMin}m`}`
      : 'off-peak'
  return jsx('span', {
    className: 'text-[0.5625rem]',
    style: { color: on ? 'var(--ui-orange)' : 'var(--ui-text-quaternary)', flex: '0 0 auto' },
    title: on
      ? `Inside a peak window (${peak.peakWindow || ''}): this model charges ×${peak.multiplier} right now`
      : `Outside peak windows (${peak.peakWindow || ''}) — you are paying the base price`,
    children: text
  })
}

/** Price vs the catalogue average: diverging bar centred on the median, log
 *  scale, so 0.12x and 8x sit at opposite ends instead of both looking "small". */
function AvgBar({ ratio }) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return null
  const r = Number(ratio)
  const offset = Math.max(-1, Math.min(1, Math.log2(r || 1) / 3)) // +/-3 doublings = full bar
  const pos = 50 + offset * 50
  const left = Math.min(50, pos)
  const width = Math.abs(pos - 50)
  const color = r < 0.9 ? 'var(--ui-green)' : r > 1.1 ? 'var(--ui-orange)' : 'var(--ui-text-quaternary)'
  return jsxs('div', {
    className: 'flex items-center gap-1.5',
    title: `${r.toFixed(2)}x the median chat-model price (log scale, centre = average)`,
    children: [
      jsxs('div', {
        style: {
          position: 'relative',
          height: 3,
          flex: '1 1 auto',
          background: 'var(--ui-stroke-secondary)',
          borderRadius: 2
        },
        children: [
          jsx('div', {
            style: {
              position: 'absolute',
              left: `${left}%`,
              width: `${width}%`,
              top: 0,
              bottom: 0,
              background: color,
              borderRadius: 2
            }
          }),
          jsx('div', {
            style: {
              position: 'absolute',
              left: '50%',
              top: -1,
              width: 1,
              height: 5,
              background: 'var(--ui-text-quaternary)',
              opacity: 0.6
            }
          })
        ]
      }),
      jsx('span', {
        className: 'tabular-nums',
        style: { color, fontSize: '0.5625rem', flex: '0 0 auto' },
        children: `${r < 1 ? r.toFixed(2) : r.toFixed(1)}× median price`
      })
    ]
  })
}

function PickRow({ model, tierLabel }) {
  if (!model) return null
  return jsxs('div', {
    className: 'flex flex-col gap-1 rounded px-1 py-1 hover:bg-(--chrome-action-hover)',
    style: { cursor: 'pointer' },
    title: `Click to copy ${model.id}`,
    onClick: () => {
      haptic('tap')
      const copied = osDoor && osDoor.writeClipboard ? osDoor.writeClipboard(model.id) : null
      if (copied && copied.then) copied.then(() => host.notify({ kind: 'info', message: `Copied ${model.id}` }))
    },
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsxs('span', {
            className: 'flex min-w-0 items-baseline gap-1',
            children: [
              tierLabel
                ? jsx('span', {
                    className: 'text-[0.5rem] uppercase tracking-wide',
                    style: { color: 'var(--ui-text-quaternary)', flex: '0 0 auto' },
                    children: tierLabel
                  })
                : null,
              jsx('span', {
                className: 'truncate text-[0.6875rem]',
                children: model.short + (model.current ? ' · you' : '')
              }),
              model.grade === 'good'
                ? jsx('span', {
                    className: 'text-[0.5rem] font-medium uppercase tracking-wide',
                    style: { color: 'var(--ui-green)', flex: '0 0 auto' },
                    title: 'good deal: strong capability for its price',
                    children: 'good deal'
                  })
                : null
            ]
          }),
          jsx('span', {
            className: 'tabular-nums text-[0.5625rem]',
            style: { color: 'var(--ui-text-tertiary)', flex: '0 0 auto' },
            title: `$${Number(model.pin).toFixed(3)} per million input tokens, $${Number(model.pout).toFixed(3)} per million output tokens`,
            children: `in $${Number(model.pin).toFixed(2)} / out $${Number(model.pout).toFixed(2)}`
          })
        ]
      }),
      jsx(Spectrum, { value: model.value, grade: model.grade }),
      jsx(AvgBar, { ratio: model.ratio }),
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5',
        children: [
          jsx('span', {
            className: 'truncate text-[0.5625rem]',
            style: { color: 'var(--ui-text-quaternary)', flex: '1 1 auto', minWidth: 0 },
            children: model.blurb
          }),
          jsx(CheaperTag, { wallet: model.cheaper }),
          jsx(SaleTag, { sale: model.sale }),
          jsx(PeakTag, { peak: model.peak })
        ]
      })
    ]
  })
}

function billingLine(data) {
  if (!data || !data.active) return null
  const walletId = data.active.wallet
  if (!walletId) return 'no route resolved'
  const card = (data.wallets || []).find((w) => w.id === walletId)
  const name = (card && card.name) || walletId
  const scope = data.active.source === 'session' ? 'this chat' : 'profile default'
  return `billing → ${name} · ${scope}`
}

/** Collapsed/expanded state per section, remembered across restarts. */
function useCollapsed(key, defaultOpen = true) {
  const [open, setOpen] = useState(() => {
    const stored = storage ? storage.get(`section:${key}`, defaultOpen) : defaultOpen
    return stored !== false
  })
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (storage) storage.set(`section:${key}`, next)
    haptic('tap')
  }
  return [open, toggle]
}

/** One foldable region: a clickable header row plus its body. The header keeps
 *  its right-hand summary visible while folded, so a collapsed section still
 *  reports what it holds instead of vanishing silently. */
function Section({ id, label, summary, tint, count, defaultOpen = true, children }) {
  const [open, toggle] = useCollapsed(id, defaultOpen)
  return jsxs('div', {
    className: 'flex flex-col gap-1 border-t pt-1.5',
    style: { borderColor: 'var(--ui-stroke-secondary)' },
    children: [
      jsxs('button', {
        type: 'button',
        className: cn(
          'flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left',
          'hover:bg-(--chrome-action-hover)'
        ),
        title: open ? `Fold ${label}` : `Unfold ${label}`,
        onClick: toggle,
        children: [
          jsxs('span', {
            className: 'flex min-w-0 items-center gap-1',
            children: [
              jsx('span', {
                className: 'text-[0.5rem]',
                style: { color: 'var(--ui-text-quaternary)', flex: '0 0 auto' },
                children: open ? '▾' : '▸'
              }),
              jsx('span', {
                className: 'text-[0.5625rem] uppercase tracking-wide',
                style: { color: tint || 'var(--ui-text-tertiary)', flex: '0 0 auto' },
                children: label
              }),
              !open && count
                ? jsx('span', {
                    className: 'text-[0.5rem]',
                    style: { color: 'var(--ui-text-quaternary)' },
                    children: count
                  })
                : null
            ]
          }),
          jsx('span', {
            className: 'text-[0.5rem]',
            style: { color: 'var(--ui-text-quaternary)', flex: '0 0 auto' },
            children: summary
          })
        ]
      }),
      open ? children : null
    ]
  })
}

function ModelPicks({ picks }) {
  if (!picks || !picks.ok || !picks.tiers || !picks.tiers.length) return null
  const tiers = picks.tiers.filter((t) => t.model)
  const currentShown = tiers.some((t) => t.model.current)
  return jsxs('div', {
    className: 'mt-1 flex flex-col gap-1.5 border-t pt-2',
    style: { borderColor: 'var(--ui-stroke-secondary)' },
    children: [
      jsx(Section, {
        id: 'picks',
        label: 'model picks',
        summary: `median $${Number(picks.avg).toFixed(2)}/Mtok`,
        count: `${tiers.length} bands`,
        children: jsx('div', {
          className: 'flex flex-col gap-1',
          children: tiers.map((tier) => jsx(PickRow, { model: tier.model, tierLabel: tier.label }, tier.key))
        })
      }),
      picks.sales && picks.sales.length
        ? jsx(Section, {
            id: 'sales',
            label: 'on sale',
            tint: 'var(--ui-green)',
            summary: picks.salesByWallet
              ? `${picks.salesByWallet.nous} Nous · ${picks.salesByWallet.vercel} Vercel`
              : `${picks.saleCount} below list`,
            count: `${picks.saleCount} below list`,
            children: jsx('div', {
              className: 'flex flex-col gap-1',
              children: picks.sales.map((m) =>
                jsx(PickRow, { model: m, tierLabel: m.sale ? `−${m.sale.pct}%` : '' }, `sale-${m.id}`)
              )
            })
          })
        : null,
      currentShown || !picks.current
        ? null
        : jsxs('div', {
            className: 'flex flex-col gap-1 border-t pt-1.5',
            style: { borderColor: 'var(--ui-stroke-secondary)' },
            children: [
              jsx('div', {
                className: 'text-[0.5625rem] uppercase tracking-wide',
                style: { color: 'var(--ui-text-tertiary)' },
                children: 'current'
              }),
              jsx(PickRow, { model: picks.current, tierLabel: picks.current.grade })
            ]
          }),
      jsx('div', {
        className: 'text-[0.5rem] leading-snug',
        style: { color: 'var(--ui-text-quaternary)' },
        children:
          'spectrum: red = pricey for its capability class → green = bargain (heuristic) · bar = price vs median · ▼% on Nous/Vercel = that wallet\'s marked-down price · "cheaper on" = lower absolute price'
      })
    ]
  })
}

function WalletsPane() {
  const q = useWallets()
  const data = q.data || null
  const err = q.error

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 overflow-auto p-2.5 text-xs',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('div', {
            className: 'text-[0.6875rem] font-medium uppercase tracking-wide',
            style: { color: 'var(--ui-text-tertiary)' },
            children: 'wallets'
          }),
          jsx('button', {
            type: 'button',
            className: 'rounded px-1.5 py-0.5 text-[0.6875rem] hover:bg-(--chrome-action-hover)',
            style: { color: 'var(--ui-text-tertiary)' },
            title: 'Refresh now',
            onClick: () => {
              haptic('tap')
              api(`/state${forceQs(q.sessionId)}`).then(() => q.refetch())
            },
            children: q.isFetching ? '···' : '↻'
          })
        ]
      }),
      err
        ? jsx('div', {
            className: 'text-[0.6875rem] leading-snug',
            style: { color: 'var(--ui-text-quaternary)' },
            children: `backend: ${err.message || err}`
          })
        : null,
      data
        ? jsxs('div', {
            className: 'flex flex-col gap-0.5',
            children: [
              jsxs('div', {
                className: 'flex items-baseline justify-between gap-2',
                children: [
                  jsx('div', { className: 'text-base font-semibold tabular-nums', children: money(data.total) }),
                  jsx('div', {
                    className: 'text-[0.625rem]',
                    style: { color: 'var(--ui-text-quaternary)' },
                    children: `updated ${data.fetchedAt}`
                  })
                ]
              }),
              jsx('div', {
                className: 'text-[0.625rem] leading-snug',
                style: { color: 'var(--ui-text-tertiary)' },
                children: billingLine(data)
              })
            ]
          })
        : null,
      // Every wallet Hermes is configured with, in the backend's order (active
      // first). Adding a gateway in Hermes is enough for a card to appear.
      ...(data && data.wallets ? data.wallets.map((w) => jsx(WalletCard, { w }, w.id)) : []),
      data && data.picks ? jsx(ModelPicks, { picks: data.picks }) : null,
      data && data.wallets && data.wallets.length && data.wallets.every((w) => !w.ok)
        ? jsx('div', {
            className: 'text-[0.625rem] leading-snug',
            style: { color: 'var(--ui-text-quaternary)' },
            children: 'No wallet reports a balance. Keys live in ~/.hermes/.env, logins via `hermes auth`.'
          })
        : null
    ]
  })
}

function WalletsChip() {
  const q = useWallets()
  const d = q.data
  const label = d ? compact(d.total) : '—'
  const wallets = (d && d.wallets) || []
  const activeCard = wallets.find((w) => w.id === (d && d.active && d.active.wallet))
  // A positive measured burn rate anywhere means tokens are being spent right
  // now — blink a dot next to the total so the spend is visible at a glance.
  const spending = wallets.some((w) => w.burn && Number(w.burn.perHour) > 0)
  const breakdown = wallets
    .filter((w) => w.balance !== null && w.balance !== undefined)
    .map((w) => `${w.name} ${money(w.balance)}`)
    .join(' · ')
  return jsx('button', {
    type: 'button',
    title: d
      ? `${breakdown || 'no balances'}${activeCard ? ` — billing ${activeCard.name}` : ''}`
      : 'Wallet balances unavailable',
    className: cn(
      'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums transition-colors',
      'hover:bg-(--chrome-action-hover)'
    ),
    style: { color: 'var(--ui-text-tertiary)' },
    onClick: () => {
      haptic('tap')
      api(`/state${forceQs(q.sessionId)}`)
    },
    children: [
      spending
        ? jsx(
            'span',
            {
              className: 'inline-block size-1.5 rounded-full animate-pulse',
              style: { background: 'var(--ui-accent)' },
              title: 'tokens being spent',
              'aria-label': 'tokens being spent'
            },
            'spend-dot'
          )
        : null,
      jsx('span', { children: label }, 'total')
    ]
  })
}

export default {
  id: ID,
  name: 'Wallets',
  register(ctx) {
    rest = ctx.rest
    osDoor = ctx.os
    storage = ctx.storage

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'wallets',
      data: { placement: 'right', width: '286px' },
      render: () => jsx(WalletsPane, {})
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 118,
      render: () => jsx(WalletsChip, {})
    })
  }
}
