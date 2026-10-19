"""Wallets backend — Nous Portal + Vercel AI Gateway balances and usage.

Mounted at /api/plugins/wallets/ by the gateway (hermes serve), so the desktop
pane reaches it through ctx.rest('/state').

Design notes:
- Never import at module scope anything that can fail hard: the panel must
  degrade per-wallet instead of taking the router down.
- Balance samples are appended to a small JSON history file (throttled) so the
  pane can show spend over 24h / 7d instead of just a snapshot.
- All handlers are sync `def` on purpose: FastAPI runs them in a worker thread,
  so the blocking portal/AI-Gateway HTTP calls never stall the event loop.
"""

from __future__ import annotations

import bisect
import json
import os
import re
from datetime import datetime, timezone
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

router = APIRouter()

CACHE_TTL = 45.0          # seconds a fetched payload is reused
SAMPLE_INTERVAL = 300.0   # seconds between history samples (5 min)
HISTORY_MAX = 4032        # 14 days at 5 min
HTTP_TIMEOUT = 15.0
AI_GATEWAY_BASE = "https://ai-gateway.vercel.sh"
# Official deep links that land on the page holding the top-up control.
VERCEL_TOPUP_URL = "https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai-gateway&title=Go+to+AI+Gateway"
NOUS_TOPUP_SUFFIX = "/billing?topup=open"

_LOCK = threading.Lock()
_CACHE: dict[str, Any] = {"at": 0.0, "payload": None}


# ── paths ────────────────────────────────────────────────────────────────────

def _hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    return Path(env) if env else Path.home() / ".hermes"


def _history_path() -> Path:
    return _hermes_home() / "state" / "wallets-history.json"


# ── credentials ──────────────────────────────────────────────────────────────

def _read_dotenv_key(name: str) -> Optional[str]:
    """Read NAME=... from $HERMES_HOME/.env without importing hermes config."""
    try:
        for line in (_hermes_home() / ".env").read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == name:
                return v.strip().strip('"').strip("'") or None
    except OSError:
        return None
    return None


def _ai_gateway_key() -> Optional[str]:
    for name in ("AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"):
        val = os.environ.get(name) or _read_dotenv_key(name)
        if val:
            return val
    return None


def _mask(key: str) -> str:
    return f"{key[:5]}…{key[-4:]}" if len(key) > 12 else f"{key[:3]}…"


# ── history ──────────────────────────────────────────────────────────────────

def _load_history() -> list[dict[str, Any]]:
    try:
        raw = json.loads(_history_path().read_text(encoding="utf-8"))
        return [s for s in raw if isinstance(s, dict) and isinstance(s.get("t"), (int, float))]
    except (OSError, ValueError):
        return []


def _save_history(samples: list[dict[str, Any]]) -> None:
    path = _history_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(samples), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def _maybe_sample(history: list[dict[str, Any]], vercel_bal: Optional[float], nous_bal: Optional[float]) -> list[dict[str, Any]]:
    now = time.time()
    if vercel_bal is None and nous_bal is None:
        return history
    if history and now - float(history[-1]["t"]) < SAMPLE_INTERVAL:
        return history
    history.append({"t": now, "vercel": vercel_bal, "nous": nous_bal})
    trimmed = history[-HISTORY_MAX:]
    _save_history(trimmed)
    return trimmed


def _burn_rate(history: list[dict[str, Any]], key: str, hours: float = 6.0) -> Optional[dict[str, Any]]:
    """Spend per hour from sampled balances, plus the runway it implies.

    Only negative deltas count, so a top-up mid-window can't mask real spend.
    Needs two samples at least 5 minutes apart; returns None rather than
    pretending a single sample is a rate.
    """
    cutoff = time.time() - hours * 3600
    window = [s for s in history if float(s["t"]) >= cutoff and s.get(key) is not None]
    if len(window) < 2:
        return None
    span = float(window[-1]["t"]) - float(window[0]["t"])
    if span < 300:
        return None
    spent = 0.0
    for prev, cur in zip(window, window[1:]):
        drop = float(prev[key]) - float(cur[key])
        if drop > 0:
            spent += drop
    per_hour = spent / (span / 3600.0)
    return {
        "perHour": round(per_hour, 4),
        "perDay": round(per_hour * 24.0, 3),
        "windowMin": int(round(span / 60.0)),
        "samples": len(window),
    }


def _spend_since(history: list[dict[str, Any]], key: str, seconds: float, current: Optional[float]) -> Optional[float]:
    """Amount spent in the window, from balance deltas.

    Sums only negative deltas between consecutive samples so a top-up in the
    middle of the window doesn't cancel out real spending.
    """
    if current is None or len(history) < 2:
        return None
    cutoff = time.time() - seconds
    window = [s for s in history if float(s["t"]) >= cutoff and s.get(key) is not None]
    if not window:
        return None
    total = 0.0
    for prev, cur in zip(window, window[1:]):
        drop = float(prev[key]) - float(cur[key])
        if drop > 0:
            total += drop
    return round(total, 4)


_WALLET_FOR_PROVIDER = {
    "vercel": "vercel", "ai-gateway": "vercel", "aigateway": "vercel", "vercel-ai-gateway": "vercel",
    "nous": "nous", "nous-api": "nous",
}


def _wallet_for(provider: Optional[str]) -> Optional[str]:
    return _WALLET_FOR_PROVIDER.get(str(provider or "").strip().lower())


def _config_route() -> dict[str, Any]:
    """What a NEW turn bills: model.provider plus the fallback chain order."""
    out: dict[str, Any] = {"primary": None, "model": None, "fallbacks": []}
    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
        model_cfg = cfg.get("model") or {}
        out["primary"] = _wallet_for(model_cfg.get("provider"))
        out["model"] = model_cfg.get("default") or model_cfg.get("model")
        chain = cfg.get("fallback_providers") or []
        if isinstance(chain, dict):
            chain = [chain]
        for entry in chain:
            if isinstance(entry, dict) and _wallet_for(entry.get("provider")):
                out["fallbacks"].append(_wallet_for(entry.get("provider")))
    except Exception:  # noqa: BLE001 — routing display is advisory, never fatal
        pass
    return out


def _session_route(session_id: Optional[str]) -> Optional[dict[str, Any]]:
    """The live route of one chat: a composer pick beats profile config per session.

    ``tui_gateway.server._sessions`` is the same process this router runs in, so
    this reads the running agent's actual override instead of guessing.
    """
    if not session_id:
        return None
    try:
        from tui_gateway.server import _sessions

        entry = _sessions.get(session_id) or {}
        override = entry.get("model_override") or {}
        provider = override.get("provider")
        model = override.get("model")
        if not provider and not model:
            return None
        return {"provider": provider, "model": model}
    except Exception:  # noqa: BLE001
        return None


# ── Vercel AI Gateway ────────────────────────────────────────────────────────

def _vercel() -> dict[str, Any]:
    key = _ai_gateway_key()
    out: dict[str, Any] = {"ok": False, "name": "Vercel AI Gateway", "balance": None,
                           "totalUsed": None, "keyHint": None, "error": None}
    if not key:
        out["error"] = "no AI_GATEWAY_API_KEY in $HERMES_HOME/.env"
        return out
    out["keyHint"] = _mask(key)
    req = urllib.request.Request(
        f"{AI_GATEWAY_BASE}/v1/credits",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        out["balance"] = float(data.get("balance")) if data.get("balance") is not None else None
        out["totalUsed"] = float(data.get("total_used")) if data.get("total_used") is not None else None
        out["ok"] = True
        # The balance button in the dashboard's top-right is where credits are
        # bought; the deep link lands on that page for whichever team is active.
        out["topUp"] = {"url": VERCEL_TOPUP_URL, "label": "add credit"}
    except urllib.error.HTTPError as exc:
        out["error"] = f"HTTP {exc.code} from AI Gateway"
    except Exception as exc:  # noqa: BLE001 — fail open per wallet
        out["error"] = f"{type(exc).__name__}: {str(exc)[:120]}"
    return out


# ── model picks (price / value) ──────────────────────────────────────────────
#
# Prices come from the gateway's own /v1/models payload (`pricing` is per-token
# decimal strings), so recommendations cost nothing: no inference, one cached
# GET every few hours. "Value" is a heuristic, NOT a benchmark — capability is
# inferred from declared tags/context, then compared with what the model costs
# relative to the rest of the catalogue. It ranks bargains; it cannot tell you
# that a cheap model is bad at your particular job.

MODELS_TTL = 6 * 3600
BAND_CHEAP, BAND_FRONTIER = 0.25, 2.0   # blended $/Mtok boundaries

_BLURB_TAGS = (
    ("reasoning", "reasoning"),
    ("tool-use", "tool calls"),
    ("vision", "vision"),
    ("structured-output", "JSON output"),
    ("implicit-caching", "prompt caching"),
    ("open-weights", "open weights"),
)


def _models_catalog(force: bool = False) -> list[dict[str, Any]]:
    """Cached /v1/models payload (the whole catalogue, ~530 KB, 6 h TTL)."""
    path = _hermes_home() / "state" / "wallets-models.json"
    now = time.time()
    blob: dict[str, Any] = {}
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        blob = {}
    if not force and blob.get("at") and now - float(blob["at"]) < MODELS_TTL and blob.get("data"):
        return blob["data"]

    key = _ai_gateway_key()
    if not key:
        return blob.get("data") or []
    req = urllib.request.Request(
        f"{AI_GATEWAY_BASE}/v1/models",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT * 2) as resp:
            data = (json.loads(resp.read().decode("utf-8", "replace")) or {}).get("data") or []
    except Exception:  # noqa: BLE001 — stale catalogue beats no catalogue
        return blob.get("data") or []
    if data:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"at": now, "data": data}), encoding="utf-8")
        except OSError:
            pass
    return data


# Image/audio/realtime models are priced per-image or per-second; comparing their
# token price to a text list price produces fake 90% "sales".
_NON_CHAT_HINTS = ("image", "audio", "realtime", "transcribe", "tts", "video", "embed", "vision-exp")

_VENDOR_ALIASES = {"meta-llama": "meta", "meta": "meta", "x-ai": "xai", "moonshotai": "moonshot"}


def _norm_model_id(model_id: str) -> str:
    """`deepseek/deepseek-v4-flash-0731` -> `deepseek-v4-flash` for list-price joins."""
    name = model_id.split("/", 1)[-1].lower()
    name = re.sub(r"-\d{8}$", "", name)
    name = re.sub(r"-\d{4}$", "", name)
    return re.sub(r"-(fast|preview|latest|exp)$", "", name)


def _list_prices() -> dict[str, dict[str, float]]:
    """Vendor list prices from the models.dev cache (already on disk).

    Returns ``{vendor: {normalized_model: {"in": $/Mtok, "out": $/Mtok}}}``.
    Used only to answer "is this cheaper than list?" — the gateway payload has
    no compare-at price of its own.
    """
    path = _hermes_home() / "models_dev_cache.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[str, dict[str, dict[str, float]]] = {}
    for vendor, blob in raw.items():
        if not isinstance(blob, dict):
            continue
        models = blob.get("models") or {}
        if not isinstance(models, dict):
            continue
        table: dict[str, dict[str, float]] = {}
        for key, model in models.items():
            cost = (model or {}).get("cost") or {}
            try:
                pin = float(cost.get("input"))
                pout = float(cost.get("output"))
            except (TypeError, ValueError):
                continue
            if pin <= 0 and pout <= 0:
                continue
            table[_norm_model_id(key)] = {"in": pin, "out": pout}
        if table:
            out[vendor] = table
    return out


def _peak_state(pricing: dict[str, Any], now: Optional[datetime] = None) -> dict[str, Any]:
    """Off-peak vs peak for models that publish a peak multiplier (DeepSeek family).

    The gateway's `peak_pricing` = {multiplier, windows[{start_minute_utc,
    end_minute_utc, days_of_week}]}; inside a window the list price is
    multiplied, so *outside* them you are effectively getting the discount.
    """
    peak = pricing.get("peak_pricing")
    if not isinstance(peak, dict):
        return {}
    windows = peak.get("windows") or []
    try:
        multiplier = float(peak.get("multiplier") or 1)
    except (TypeError, ValueError):
        return {}
    if not windows or multiplier <= 1:
        return {}

    now = now or datetime.now(timezone.utc)
    minute_of_day = now.hour * 60 + now.minute
    weekday = now.isoweekday()  # 1=Mon .. 7=Sun

    for window in windows:
        try:
            start = int(window.get("start_minute_utc"))
            end = int(window.get("end_minute_utc"))
        except (TypeError, ValueError):
            continue
        days = window.get("days_of_week") or []
        if days and weekday not in days:
            continue
        if start <= minute_of_day < end:
            return {"inPeak": True, "multiplier": multiplier, "until": _hhmm(end),
                    "peakWindow": f"{_hhmm(start)}-{_hhmm(end)}Z"}

    soonest = None
    for window in windows:
        try:
            start = int(window.get("start_minute_utc"))
        except (TypeError, ValueError):
            continue
        days = sorted(window.get("days_of_week") or [])
        for offset in range(0, 8):
            day = ((weekday - 1 + offset) % 7) + 1
            if days and day not in days:
                continue
            if offset == 0 and start <= minute_of_day:
                continue
            delay = offset * 1440 + start - minute_of_day
            if delay <= 0:
                continue
            if soonest is None or delay < soonest:
                soonest = delay
    return {"inPeak": False, "multiplier": multiplier,
            "startsInMin": soonest, "peakWindow": f"{_hhmm(int(windows[0].get('start_minute_utc', 0)))}Z"}


def _hhmm(minute_of_day: int) -> str:
    return f"{(minute_of_day // 60) % 24:02d}:{minute_of_day % 60:02d}"


def _chat_rows(catalog: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Chat-capable, priced, interactive models. Batch/free/stealth are excluded:
    batch is async-only (half price, not usable in a live chat) and the free
    entries are throwaway aliases that would win every price sort."""
    rows: list[dict[str, Any]] = []
    for model in catalog:
        if model.get("type") != "language":
            continue
        if "text" not in ((model.get("modalities") or {}).get("output") or []):
            continue
        mid = str(model.get("id") or "")
        if not mid or "/stealth/" in mid or mid.endswith("-free") or mid.endswith("-batch"):
            continue
        if any(bad in mid.lower() for bad in _NON_CHAT_HINTS):
            continue
        pricing = model.get("pricing") or {}
        try:
            pin = float(pricing.get("input") or 0) * 1e6
            pout = float(pricing.get("output") or 0) * 1e6
        except (TypeError, ValueError):
            continue
        if pin <= 0 and pout <= 0:
            continue
        tags = set(model.get("tags") or [])
        ctx = int(model.get("context_window") or 0)
        cap = 1.0
        cap += 0.6 if "reasoning" in tags else 0.0
        cap += 0.6 if "tool-use" in tags else 0.0
        cap += 0.3 if "vision" in tags else 0.0
        cap += 0.2 if "structured-output" in tags else 0.0
        if ctx >= 1_000_000:
            cap += 0.5
        elif ctx >= 200_000:
            cap += 0.3
        # 3:1 input:output is the usual agent-workload mix.
        rows.append({
            "id": mid,
            "vendor": mid.split("/", 1)[0].lower(),
            "pin": pin, "pout": pout,
            "blended": (3 * pin + pout) / 4,
            "cap": cap, "ctx": ctx, "tags": sorted(tags),
            "desc": str(model.get("description") or ""),
            "peak": _peak_state(pricing),
        })
    return rows


NOUS_MODELS_URL = "https://inference-api.nousresearch.com/v1/models"
NOUS_TTL = 6 * 3600


def _nous_catalog() -> dict[str, dict[str, Any]]:
    """Nous Portal per-model prices, normalised name -> {in, out, listIn, listOut}.

    The inference API publishes `pricing.prompt` / `pricing.completion` (per
    token) and, when the model is discounted, `pricing.original` — the
    compare-at price. That `original` is Nous's own "on sale" flag, which is
    what makes it possible to say WHICH wallet carries the discount.
    """
    path = _hermes_home() / "state" / "wallets-nous-models.json"
    now = time.time()
    cached: dict[str, Any] = {}
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("names") and now - float(cached.get("at") or 0) < NOUS_TTL:
            return {"exact": cached.get("exact") or {}, "names": cached["names"]}
    except (OSError, ValueError):
        cached = {}

    try:
        from hermes_cli.auth import resolve_nous_access_token

        token = resolve_nous_access_token()
        req = urllib.request.Request(
            NOUS_MODELS_URL,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = (json.loads(resp.read().decode("utf-8", "replace")) or {}).get("data") or []
    except Exception:  # noqa: BLE001 — Nous pricing is an extra, never fatal
        return {"exact": cached.get("exact") or {}, "names": cached.get("names") or {}}

    names: dict[str, dict[str, Any]] = {}
    exact: dict[str, dict[str, Any]] = {}
    for model in data:
        mid = str(model.get("id") or "")
        # `:batch`, `:US` and `~`-prefixed ids are variant SKUs; matching them
        # against the plain gateway id reports the wrong price (a $0.36 regional
        # SKU against a $0.05 global one).
        if not mid or mid.startswith("~") or ":" in mid:
            continue
        pricing = model.get("pricing") or {}
        try:
            pin = float(pricing.get("prompt")) * 1e6
            pout = float(pricing.get("completion")) * 1e6
        except (TypeError, ValueError):
            continue
        if pin <= 0 and pout <= 0:
            continue
        original = pricing.get("original") or {}
        try:
            list_in = float(original.get("prompt")) * 1e6
            list_out = float(original.get("completion")) * 1e6
        except (TypeError, ValueError):
            list_in = list_out = None
        entry = {"in": round(pin, 4), "out": round(pout, 4)}
        if list_in and list_out:
            entry["listIn"] = round(list_in, 4)
            entry["listOut"] = round(list_out, 4)
        exact[mid] = entry
        # Exact ids win; the normalised map only fills models Nous lists under a
        # different date stamp. Never let a stripped name overwrite an exact one.
        names.setdefault(_norm_model_id(mid), entry)
    if exact:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"at": now, "exact": exact, "names": names}), encoding="utf-8")
        except OSError:
            pass
    return {"exact": exact, "names": names}


def _annotate_wallets(rows: list[dict[str, Any]]) -> None:
    """Answer "which wallet do I pay to get this price?" per model.

    Two independent facts per row:
      - `cheaper`: the wallet with the lower blended price ('nous'|'vercel'),
      - `sale`:    a discount, tagged with the wallet that is running it.
    Nous reports its compare-at price as `pricing.original`; Vercel has no
    compare-at field, so its discount is measured against models.dev list.
    """
    catalog = _nous_catalog()
    exact_map = catalog.get("exact") or {}
    name_map = catalog.get("names") or {}
    list_prices = _list_prices()
    for row in rows:
        norm = _norm_model_id(row["id"])
        row_nous = exact_map.get(row["id"]) or name_map.get(norm)

        if row_nous:
            row["nousIn"] = row_nous["in"]
            row["nousOut"] = row_nous["out"]
            nous_blended = (3 * row_nous["in"] + row_nous["out"]) / 4
            row["nousBlended"] = round(nous_blended, 4)
            diff = row["blended"] - nous_blended
            if abs(diff) < 0.0005:
                row["cheaper"] = None
            else:
                row["cheaper"] = "nous" if diff > 0 else "vercel"
            if row_nous.get("listIn") and row_nous.get("listOut"):
                list_blended = (3 * row_nous["listIn"] + row_nous["listOut"]) / 4
                cut = 1 - nous_blended / list_blended
                if cut >= 0.10:
                    row["sale"] = {"pct": round(cut * 100), "wallet": "nous", "list": round(list_blended, 4)}

        # Vercel-side discount (only when Nous isn't already flagged cheaper-side)
        if not row.get("sale"):
            vendor = _VENDOR_ALIASES.get(row["vendor"], row["vendor"])
            entry = (list_prices.get(vendor) or {}).get(norm)
            if entry:
                list_blended = (3 * entry["in"] + entry["out"]) / 4
                if list_blended > 0:
                    row["vercelList"] = round(list_blended, 4)
                    cut = 1 - row["blended"] / list_blended
                    if cut >= 0.10:
                        row["sale"] = {"pct": round(cut * 100), "wallet": "vercel", "list": round(list_blended, 4)}


def _annotate_sales(rows: list[dict[str, Any]]) -> None:
    """Attach `sale` ({pct, listBlended}) where the gateway undercuts list price."""
    table = _list_prices()
    for row in rows:
        vendor = _VENDOR_ALIASES.get(row["vendor"], row["vendor"])
        entry = (table.get(vendor) or {}).get(_norm_model_id(row["id"]))
        if not entry:
            continue
        list_blended = (3 * entry["in"] + entry["out"]) / 4
        if list_blended <= 0:
            continue
        row["listBlended"] = round(list_blended, 4)
        cut = 1 - (row["blended"] / list_blended)
        if cut >= 0.10:
            row["sale"] = {"pct": round(cut * 100), "list": round(list_blended, 4)}


def _percentile_ranks(values: list[float]) -> list[float]:
    ordered = sorted(values)
    n = len(ordered)
    if n == 0:
        return []
    out = []
    for v in values:
        lo = bisect.bisect_left(ordered, v)
        hi = bisect.bisect_right(ordered, v)
        out.append((lo + (hi - lo) / 2) / n)
    return out


def _grade(value: float) -> str:
    """Price-for-capability verdict, used for the coloured dot."""
    if value >= 0.35:
        return "good"
    if value >= 0.10:
        return "fair"
    return "premium"


def _blurb(row: dict[str, Any], current: bool) -> str:
    bits = [label for tag, label in _BLURB_TAGS if tag in row["tags"]][:2]
    ctx = row["ctx"]
    span = f"{ctx / 1_000_000:.1f}M ctx" if ctx >= 1_000_000 else (f"{ctx // 1000}k ctx" if ctx else "")
    if current:
        return "your current pick" + (f" · {span}" if span else "")
    return " · ".join([b for b in [" · ".join(bits), span] if b]) or "chat model"


_PICKS_CACHE: dict[str, Any] = {"key": None, "at": 0.0, "value": None}


def _picks(current_id: Optional[str]) -> dict[str, Any]:
    now = time.time()
    if _PICKS_CACHE["key"] == current_id and now - float(_PICKS_CACHE["at"]) < 600:
        return _PICKS_CACHE["value"]

    rows = _chat_rows(_models_catalog())
    if not rows:
        return {"ok": False, "tiers": [], "current": None, "count": 0, "sales": []}
    _annotate_wallets(rows)

    price_pct = _percentile_ranks([r["blended"] for r in rows])
    cap_pct = _percentile_ranks([r["cap"] for r in rows])
    for row, pp, cp in zip(rows, price_pct, cap_pct):
        row["value"] = cp - pp
        row["capPct"] = cp

    blends = sorted(r["blended"] for r in rows)
    avg = blends[len(blends) // 2]

    def shape(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "short": row["id"].split("/", 1)[-1],
            "vendor": row.get("vendor"),
            "pin": round(row["pin"], 4),
            "pout": round(row["pout"], 4),
            "blended": round(row["blended"], 4),
            "ratio": round(row["blended"] / avg, 3) if avg else None,
            "value": round(row["value"], 3),
            "grade": _grade(row["value"]),
            "ctx": row["ctx"],
            "tags": row["tags"][:4],
            "blurb": _blurb(row, current_id == row["id"]),
            "current": current_id == row["id"],
            "sale": row.get("sale"),
            "peak": row.get("peak") or None,
            "nousIn": row.get("nousIn"),
            "nousOut": row.get("nousOut"),
            "cheaper": row.get("cheaper"),
        }

    def best_in(lo: float, hi: float) -> Optional[dict[str, Any]]:
        in_band = [r for r in rows if lo <= r["blended"] < hi]
        # Above-median capability, else the cheapest junk wins every band.
        candidates = [r for r in in_band if "tool-use" in r["tags"] and r.get("capPct", 0) >= 0.55]
        if not candidates:
            candidates = [r for r in in_band if "tool-use" in r["tags"]]
        if not candidates:
            candidates = in_band
        if not candidates:
            return None
        # Best value, but prefer a different vendor than the tier above so the
        # strip isn't three rows of the same family.
        candidates.sort(key=lambda r: (-r["value"], r["blended"]))
        return shape(candidates[0])

    tiers = [
        ("dirt", "dirt cheap", 0.0, 0.08),
        ("cheap", "cheap", 0.08, BAND_CHEAP),
        ("mid", "mid", BAND_CHEAP, 0.75),
        ("upper", "capable", 0.75, BAND_FRONTIER * 3),
        ("frontier", "frontier", BAND_FRONTIER * 3, float("inf")),
    ]
    out_tiers = []
    seen_ids: set[str] = set()
    for key, label, lo, hi in tiers:
        pick = best_in(lo, hi)
        if pick and pick["id"] in seen_ids:
            pick = next((shape(r) for r in sorted([x for x in rows if lo <= x["blended"] < hi],
                                                  key=lambda r: -r["value"])
                         if r["id"] not in seen_ids), pick)
        if pick:
            seen_ids.add(pick["id"])
        out_tiers.append({"key": key, "label": label, "model": pick})

    current_row = next((r for r in rows if r["id"] == current_id), None)
    # What is genuinely below its own list price right now — the "is anything on
    # sale?" answer. Requires above-median capability so the list isn't junk.
    # "Capable" here = can actually run an agent loop (tool use or reasoning)
    # with room for context. The percentile gate was too strict: tag coverage
    # varies per vendor, so genuinely strong models landed below the median.
    on_sale = sorted(
        [r for r in rows if r.get("sale")
         and ({"tool-use", "reasoning"} & set(r["tags"]))
         and r["ctx"] >= 100_000],
        key=lambda r: (-r["sale"]["pct"], -r["value"]),
    )
    by_wallet = {"nous": 0, "vercel": 0}
    for r in on_sale:
        wallet = (r.get("sale") or {}).get("wallet")
        if wallet in by_wallet:
            by_wallet[wallet] += 1

    result = {
        "ok": True,
        "count": len(rows),
        "avg": round(avg, 4),
        "tiers": out_tiers,
        "current": shape(current_row) if current_row else None,
        "sales": [shape(r) for r in on_sale[:3]],
        "saleCount": len(on_sale),
        "salesByWallet": by_wallet,
    }
    _PICKS_CACHE.update(key=current_id, at=now, value=result)
    return result


# ── Nous Portal ──────────────────────────────────────────────────────────────

def _num(value: Any) -> Optional[float]:
    try:
        f = float(str(value).replace("$", "").strip())
        return f
    except (TypeError, ValueError):
        return None


def _nous() -> dict[str, Any]:
    out: dict[str, Any] = {
        "ok": False, "name": "Nous Portal", "balance": None, "subscriptionUsd": None,
        "purchasedUsd": None, "monthSpent": None, "monthCap": None, "plan": None,
        "renewsAt": None, "email": None, "tier": None, "error": None,
    }

    # Billing state = balance + monthly spend (authoritative spend surface).
    try:
        from hermes_cli import nous_billing as nb

        try:
            state = nb.get_billing_state(timeout=HTTP_TIMEOUT)
        except nb.BillingAuthError:
            out["error"] = "not logged in to Nous Portal"
            return out
        except Exception as exc:  # noqa: BLE001
            out["error"] = f"billing API: {type(exc).__name__}: {str(exc)[:100]}"
            state = None

        if isinstance(state, dict):
            out["balance"] = _num(state.get("balanceUsd"))
            cap = state.get("monthlyCap") or {}
            if isinstance(cap, dict):
                out["monthSpent"] = _num(cap.get("spentThisMonthUsd"))
                out["monthCap"] = _num(cap.get("limitUsd"))
            org = state.get("org") or {}
            if isinstance(org, dict):
                out["org"] = org.get("name")
                out["orgRole"] = org.get("role")
            power = state.get("purchasingPower") or {}
            if isinstance(power, dict):
                out["tier"] = power.get("tierName")
            bounds = state.get("bounds") or {}
            min_usd = _num(bounds.get("minUsd")) if isinstance(bounds, dict) else None
            portal = state.get("portalUrl")
            base = portal if isinstance(portal, str) and portal.startswith("http") else None
            if not base:
                try:
                    base = nb.resolve_portal_base_url().rstrip("/") + NOUS_TOPUP_SUFFIX
                except Exception:  # noqa: BLE001
                    base = "https://portal.nousresearch.com" + NOUS_TOPUP_SUFFIX
            out["topUp"] = {"url": base, "label": "add credit", "minUsd": min_usd}
            out["ok"] = out["balance"] is not None
    except Exception as exc:  # noqa: BLE001 — import guard
        out["error"] = f"billing module unavailable: {type(exc).__name__}"

    # Account info = subscription vs top-up split, plan, renewals.
    try:
        from hermes_cli.nous_account import get_nous_portal_account_info

        # force_fresh: the local JWT snapshot is sparse (no credit split, no
        # email), so it can't answer "how much is top-up vs subscription".
        info = get_nous_portal_account_info(force_fresh=True)
        access = getattr(info, "paid_service_access_info", None)

        def field(name: str) -> Any:
            if isinstance(access, dict):
                return access.get(name)
            return getattr(access, name, None)

        if access is not None:
            out["subscriptionUsd"] = _num(field("subscription_credits_remaining"))
            out["purchasedUsd"] = _num(field("purchased_credits_remaining"))
            if out["balance"] is None:
                out["balance"] = _num(field("total_usable_credits"))
                out["ok"] = out["balance"] is not None
        if getattr(info, "email", None):
            out["email"] = info.email
        sub = getattr(info, "subscription", None)
        if isinstance(sub, dict):
            out["plan"] = sub.get("tier") or sub.get("plan") or sub.get("name")
            out["renewsAt"] = sub.get("current_period_end") or sub.get("renews_at")
        if not getattr(info, "logged_in", False) and not out["ok"] and not out["error"]:
            out["error"] = "not logged in to Nous Portal"
    except Exception as exc:  # noqa: BLE001
        if not out["error"]:
            out["error"] = f"account API: {type(exc).__name__}: {str(exc)[:100]}"

    return out


# ── assembly ─────────────────────────────────────────────────────────────────

def _decorate(payload: dict[str, Any], session_id: Optional[str]) -> dict[str, Any]:
    """Per-request layer: which wallet is billing right now.

    Kept out of the cached payload on purpose — the cache is about money (45 s
    of network calls), while the active route changes the instant the user
    switches model in a different chat.
    """
    route = _config_route()
    live = _session_route(session_id) or {}
    active_provider = live.get("provider") or route.get("primary")
    active_wallet = _wallet_for(active_provider)

    out = dict(payload)
    for key in ("vercel", "nous"):
        wallet = dict(out.get(key) or {})
        if key == active_wallet:
            wallet["role"] = "active"
        elif key == route.get("primary"):
            wallet["role"] = "primary"
        elif key in (route.get("fallbacks") or []):
            wallet["role"] = "fallback"
        else:
            wallet["role"] = None
        out[key] = wallet

    out["active"] = {
        "wallet": active_wallet,
        "provider": active_provider,
        "model": live.get("model") or route.get("model"),
        "source": "session" if live.get("provider") else "profile",
    }
    out["primaryWallet"] = route.get("primary")
    out["fallbackWallets"] = route.get("fallbacks") or []
    out["picks"] = _picks(out["active"].get("model"))
    return out


def build_state(force: bool = False, session_id: Optional[str] = None) -> dict[str, Any]:
    now = time.time()
    with _LOCK:
        cached = _CACHE["payload"]
        if not force and cached is not None and now - float(_CACHE["at"]) < CACHE_TTL:
            return _decorate(cached, session_id)

    vercel = _vercel()
    nous = _nous()

    history = _load_history()
    history = _maybe_sample(history, vercel.get("balance"), nous.get("balance"))

    for wallet, key in ((vercel, "vercel"), (nous, "nous")):
        wallet["spent24h"] = _spend_since(history, key, 24 * 3600, wallet.get("balance"))
        wallet["spent7d"] = _spend_since(history, key, 7 * 24 * 3600, wallet.get("balance"))
        wallet["burn"] = _burn_rate(history, key)
        burn = wallet["burn"]
        balance = wallet.get("balance")
        if burn and balance is not None and burn["perHour"] > 0:
            # Hours straight from the hourly rate: rounding days to 1dp first
            # turned 8.2 h into "7 hours" (0.3 d * 24).
            wallet["runwayHours"] = round(float(balance) / burn["perHour"], 1)
            wallet["runwayDays"] = round(float(balance) / burn["perDay"], 1) if burn["perDay"] > 0 else None
        else:
            wallet["runwayHours"] = None
            wallet["runwayDays"] = None

    total = 0.0
    have_total = False
    for w in (vercel, nous):
        if w.get("balance") is not None:
            total += float(w["balance"])
            have_total = True

    payload = {
        "ts": now,
        "fetchedAt": time.strftime("%H:%M:%S"),
        "vercel": vercel,
        "nous": nous,
        "total": round(total, 2) if have_total else None,
        "sampleCount": len(history),
        "currency": "USD",
    }
    with _LOCK:
        _CACHE["at"] = now
        _CACHE["payload"] = payload
    return _decorate(payload, session_id)


def _record_hit() -> None:
    """Touch a tiny telemetry file so 'is the pane actually polling?' is answerable.

    Also lets the user (or Hermes) see that the widget is alive after an app
    restart without needing a screenshot.
    """
    path = _hermes_home() / "state" / "wallets-pane-hits.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {"hits": 0}
    data["hits"] = int(data.get("hits") or 0) + 1
    data["lastHit"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass


@router.get("/state")
def state(force: bool = False, session_id: Optional[str] = None) -> dict[str, Any]:
    _record_hit()
    return build_state(force=force, session_id=session_id)


@router.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "plugin": "wallets"}
