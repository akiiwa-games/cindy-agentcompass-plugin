# Real Cindy 0.1.121, plugin 0.3.0, 2026-11-03

A dated record. It is the run of plugin 0.3.0 with the earlier built-in router (AgentCompass 0.3.x rules, before the v0.6.0 engine and before the quick-text classifier). Nothing here
was re-run for v0.6.0; current behaviour is in [the reference](../REFERENCE.md). Every tool call with its full answer, every receipt and decision, and the screenshots are in this directory
(`acceptance.json`; times are UTC; the guest user is the Windows Sandbox's own account).

## Environment

- A fresh Windows Sandbox guest, destroyed afterwards. Official Windows Cindy **0.1.121** global installer (SHA256 `6c8e485e4a200a5d41930dc74c3fbadcf23180bb1d886c3cda3b8a5ff056894b`),
  installed silently; Cindy's "skip login" path with Codex and Claude sign-ins copied into the guest for this run only. No credential is recorded in the evidence.
- No `agentcompass` and no `python` on `PATH`, no `router.json`, no `~/.agent-compass` before Cindy started.
- `plugin/` installed by the Cindy agent with `ghost_forge_install` and later updated in place the same way; Write access **Full access**, Working folder the calling dialogue's folder.
- Each scenario was driven by asking the Cindy agent (GPT-6.1-Sol) to call the tools through `ghost_call`; the UI was operated over CDP.

## Results

| # | Scenario | Engine answer | Result |
|---|---|---|---|
| 1 | Review a file for correctness bugs | `claude` / `claude-opus-5-5` / `max` | completed, `messages_complete: true`, exact final report collected |
| 2 | Add docstrings to each function | `codex` / `gpt-6.1-sol` / `high` | completed, file changed as asked |
| 3 | Search the web for the IndexError docs | `pi` / `chatgpt/gpt-6.1-terra` / `medium` | completed with the quoted docs and URL |
| 4 | Two `Task 1:` / `Task 2:` deliverables; "What does len() return for an empty list?" | `split` (`task_count: "2"`); `self` | nothing started |
| 5 | "Use fast mode: add a type hint ..." | `codex` / `gpt-6.1-sol` / `high`, fast `true` | quota read from Cindy's own Codex telemetry (22% used); completed |
| 6 | A long tutorial, then `cleanup` while running, then `stop` | `codex` / `gpt-6.1-sol` / `high` | `cleanup_refused` with `next_tool: stop`; `stop` returned `confirmed_terminal: true` 2.4 s later; the file was never written |
| 7 | `config.json {"engine":"cli"}` with no CLI installed | `self` with `engine_note` naming the built-in fallback | removed afterwards |

Every task was created with `permissionMode: "bypassPermissions"` and the exact catalog route; each run's `acceptedConfig` equals the route, and each task's input is the full task plus the
return-channel contract. Cleanup answered `manual_cleanup_required` each time; the five tasks were then archived from Cindy's task list.

- **Cancel.** Cindy 0.1.121 labels the cancelled run `completed`, not `cancelled`; the plugin reports Cindy's status unchanged. Cindy's cancel is a graceful stop (see the cancel section of the reference).
- **Quota telemetry.** Cindy runs Codex with its own `CODEX_HOME` (`%APPDATA%\CindyGlobal\codex-home`), which the plugin process does not inherit; the guest's `~/.codex` stayed empty. The engine therefore reads
  `$CODEX_HOME`, else both `~/.codex` and Cindy's codex home; fast mode in scenario 5 depends on it.
- **Icon and languages.** The list and detail pages show the icon, `v0.3.0`, the description and four tools; with Cindy set to English, 日本語, 한국어 and 简体中文 in turn, the description and `roll` text
  appear in that language (`locale-*.png`, `tool-roll-*.png`).

## Earlier acceptance, same build, same day

The plugin's earlier form (the AgentCompass 0.3.4 wheel with `--parent-host cindy`, external router only) in a Windows Sandbox with a Codex account: install, dispatch through `ghost_call`, exact routing
(`codex / openai / gpt-6.1-sol / medium`) and exact result collection passed (the result file was `CINDY_REAL_ACCEPTANCE_OK`, 24 bytes). It found two defects, both fixed: the schemaVersion 3 manifest lacked
`minCindyVersion`, and `archive` had been required although 0.1.121 does not expose it. **Cancelling a running foreground command failed**: `stop` at 13:14:50 +08 returned `stopping`, and at 13:16:09 +08 the host
reported `completed` after the command wrote the marker file that must not exist after a cancel (22 bytes, SHA256 `b6703b59c0006d0aceb58089183d4b7ca3d3abd79442bf84af8efda9e5311f9b`). That is the behaviour
`patches/cindy-0.1.121-cancel.patch` and `scripts/cindy_0_1_121_cancel_hotfix.py` address.
