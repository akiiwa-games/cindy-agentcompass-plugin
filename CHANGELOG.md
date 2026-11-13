# Changelog

## 0.4.1

- The plugin no longer reads Cindy's `owners/*/ghost-errand-prefs.json` (Cindy's private app data), for any owner. A model changed on the plugin card is picked up by the next
  classification once the cached answer (10 minutes by default) or a classifier cooldown (at most 5 minutes) has run out. A cooldown still ends at once when the declared
  `oneshotModel` or the catalog changes.
- Every quota window the Codex log reports is handed to the engine; the plugin no longer hides one the plan table does not list. With AgentCompass v0.6.0 an undeclared window takes the
  Codex rows out of automatic routing (`capacity_unknown`), as the engine intends.
- The engine is re-vendored at Magpie `35a7aea` (0.2.1, AgentCompass `2844342`): a `needs_visual` task requires image input at every `tool_operation` level.

## 0.4.0

AgentCompass v0.6.0 engine (Magpie `ac494f3`) and the quick-text classifier. Run on real Cindy 0.1.135:
[docs/real-cindy-0.1.135-plugin-0.4.0/](docs/real-cindy-0.1.135-plugin-0.4.0/README.md).
