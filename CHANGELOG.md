# Changelog

## 0.4.1

- The plugin no longer reads Cindy's `owners/*/ghost-errand-prefs.json` (Cindy's private app data), for any owner. A model changed on the plugin card is picked up by the next
  classification once the cached answer (10 minutes by default) or a classifier cooldown (at most 5 minutes) has run out. A cooldown still ends at once when the declared
  `oneshotModel` or the catalog changes.
- The engine is re-vendored at Magpie `35a7aea` (0.2.1, AgentCompass `2844342`): a `needs_visual` task requires image input at every `tool_operation` level.
- **Removed: quota gating and quota-driven fast mode.** The plugin no longer reads the local Codex session log (`$CODEX_HOME`, `~/.codex`, Cindy's `codex-home`) or keeps `quota-state.json`, and it
  attaches no quota to any connection. A quota reading belongs to the account it was read from, and the catalog cannot tell the user's own Codex sign-in from the Cindy gateway (it gives only a `providerId`
  per row); on signed-in Cindy 0.1.135 the reading had been attached to the gateway, so the user's Codex plan appeared on every decision, including routes that spend gateway credit. Every row now runs on the
  engine's built-in unmetered gateway account and is ranked by capability fit; `decision` lists no `quota` or `accounts`, and fast mode is never chosen (`wants_fast` stays in the profile and the decision).
  The plugin reads nothing under Cindy's own data directory and nothing under a Codex home. Quota gating returns when Cindy offers connection kind and quota through its plugin API.

## 0.4.0

AgentCompass v0.6.0 engine (Magpie `ac494f3`) and the quick-text classifier. Run on real Cindy 0.1.135:
[docs/real-cindy-0.1.135-plugin-0.4.0/](docs/real-cindy-0.1.135-plugin-0.4.0/README.md).
