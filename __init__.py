"""Wallets — agent half.

The feature itself is UI + backend only (desktop pane at
~/.hermes/plugins/wallets/desktop/plugin.js, routes from
dashboard/plugin_api.py). This module exists so the package is a valid
Hermes plugin to the loader; it registers nothing.
"""


def register(ctx):  # noqa: ARG001 - nothing to register
    """No tools, hooks or commands: the pane is driven over /api/plugins/wallets."""
    return None
