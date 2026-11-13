# Real Cindy 0.1.135, plugin 0.4.0, 2026-11-13

A dated record: plugin 0.4.0 (AgentCompass v0.6.0 engine as vendored from Magpie `ac494f3`, quick-text classifier) on a real, signed-in Cindy, in a disposable Windows Sandbox guest that was closed afterwards.
Every operation's receipt and router output, the live-catalog checks and the agent transcripts are in [acceptance.json](acceptance.json) (times are UTC; the account's address, name and ids are redacted).
The kit that drives such a run is in [`test/real-cindy/`](../../test/real-cindy/README.md).

## Environment

- Official `cindy-0.1.135-win32-x64-global.exe` (published 2026-11-12), 221,039,464 bytes, SHA256 `e5a72be8b2b18c0ba4b448206fc0b4710f71c05df6eb70019f5c957639dc6cdb`, equal to the digest the release publishes;
  Authenticode `Valid`, signer X.D. Network Inc. (DigiCert Trusted G4 chain). It ran only inside the guest (`/S /currentuser`, exit 0).
- Zero configuration before Cindy started: no `agentcompass`, `python`, `node`, `npm` or `git` on PATH and no `~/.agent-compass`, `~/.codex` or `~/.claude` (`zero_config_probe`).
- Signed in to a Cindy account (cloud mode) by the owner, who received the code; the Setup gate no longer stopped any call. The Codex and Claude sign-ins were copied into the guest with refresh tokens emptied, and removed from the host as soon as the guest had them.
- The live catalog (`tasks.models()`): 84 rows, 28 models on each of the `cc`, `codex` and `pi` harnesses, every row on provider `xd` (the Cindy AI gateway). Every route below was checked against it.

[setup-card.png](setup-card.png): the Setup card a signed-out call meets (`SETUP_CANCELLED` when cancelled; the plugin did not run). [signin-screen.png](signin-screen.png): Cindy's sign-in screen.
[install-consent.png](install-consent.png): the plugin install consent.

## Scenarios

Plugin commit: scenario 1 ran on `0f9c5ab`; every other scenario on `9f78178`, which is `0f9c5ab` with `plugin/engine/route.mjs` updated in place in the guest at about 09:41 UTC (each scenario's `plugin_commit` is in `acceptance.json`).
Plugin 0.4.1 (prefs read removed, engine at Magpie `35a7aea`, see [CHANGELOG](../../CHANGELOG.md)) came after this run and was verified with `npm test` and the fake-host sandbox, not on real Cindy.

For each started run the record asserts the contract, not the winner: the route is a row of the live catalog, `acceptedConfig` equals the route, the task input is the task plus the return-channel
contract, and `messages_complete` is true before the final message is taken. All of those held for every run that started.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | default route, read-only review | classifier `xd/deepseek/deepseek-v4-flash`, 63 of 66 calibration cases fitted; routed `anthropic/claude-sonnet-5-5` on the `codex` harness at high; completed |
| 2 | one-line edit | completed, file changed, cleanup answered `cleaned` (the archive API exists on 0.1.135) |
| 3 | single web lookup | completed |
| 4 | fast-mode wording | `wants_fast` true; the route was a `claude`-harness row, which has no fast mode, so fast stayed off |
| 5 | cleanup while running, then stop | `cleanup_refused` with `next_tool` stop; stop answered `stopping`, `confirmed_terminal` false; the run later ended `failed` (Cindy-side finding 1) |
| 6 | `split` and `self` gates | `split` with `task_count` "2"; `self`; nothing started in either |
| 7 | caller `profile` | `profile_source: caller`, no classification, completed |
| 8 | 15,400-character task | classified with 14 of 66 calibration cases, answered `self`; nothing started |
| 9 | 20,399-character task | `blocked` `task_too_long_for_classifier`: 525 characters over Cindy's 32,768-character quick-text prompt with no calibration cases left; nothing started |
| 10 | GUI-demanding task | profile `needs_gui`, `needs_visual`, `tool_operation` 3; routed `google/gemini-3.8-flash`; completed |
| 11 | no classifier model | card pinned to a model Cindy cannot serve: `blocked` `classifier_no_candidate`; the next task `classifier_cooling_down` (28 s); nothing started |
| 11b | classifier follows the card | card on `meta/muse-ember`: `classifier_model` `xd/meta/muse-ember`, two tasks completed |
| 12 | recovery; `config.json` asking for the CLI | after the cooldown a classification succeeded and cleared it; with `{"engine":"cli"}` and no CLI the built-in engine answered with `engine_note` |
| 13 | leftovers | classification creates nothing in the task list; every worker task had been cleaned |

Classifications spent: 15 receipts carry a classification (the model-run scenarios, the two scenario-1 attempts that did not start a worker, the long task, the split and self gates and the recoveries), one classifier failure,
and none for scenario 9 or the cooling-down answer. The owner's Codex weekly window was about 7% left at the start, so every task was tiny.

Two attempts at scenario 1 did not start a worker, both from my set-up: `blocked` "Created draft has different route/permissions/workdir" (the plugin card Working folder is not the calling dialogue's own folder; the receipt is replayed for the same task text),
and `unknown_create` "Requested permission exceeds plugin dispatch policy" (a prefs file I rewrote had a UTF-8 BOM that Cindy ignores).

## The three review findings (PR #275)

1. **`effortRows` intersects Cindy's efforts with the dispatch table.** Valid in code, kept as is. On the live catalog no row is `not_dispatchable`; 12 rows (gpt-5.6-luna, gpt-6-luna, gpt-6.1-terra and claude-haiku-5-5, on `cc`, `codex` and `pi`)
   are narrowed from low…max to high. `no_route` appears only for a catalog that offers nothing inside the table.
2. **Image input.** Measured on the vendored `ac494f3` engine: on Cindy 0.1.135's catalog one model (`deepseek/deepseek-v4-pro`, `image_input: no`) routed for a profile with `needs_visual: true` and `tool_operation` below 3,
   because v0.6.0 demanded image input only at `tool_operation` 3. Fixed upstream (AgentCompass `2844342`, Magpie port `35a7aea`, 0.2.1) and by re-vendoring in plugin 0.4.1. Re-measured offline, not on real Cindy
   (the guest was closed): that row is now excluded with "model does not accept image input" at `tool_operation` 0 and 1 on the `pi`, `cc` and `codex` harnesses; the previous engine routed it.
3. **Undeclared quota window.** Valid, fixed in the plugin (`plugin/engine/route.mjs`, 9f78178): every window the Codex log reports now goes to the engine, which takes every Codex row out of automatic routing
   when a window is not declared (`capacity_unknown`, plus "confirmed exhausted or below launch floor" at 0% left). Plus declares both windows, so the owner's account still routes; a Codex Pro or Pro100 log carrying a five-hour window
   now leaves Codex rows out, as in v0.6.0.

## Quota attribution (not fixed)

The Codex session-log quota is attributed to the Cindy AI gateway connection.

- Evidence: all 84 catalog rows (harnesses `cc`, `codex` and `pi`) have `providerId` `xd`. The plugin therefore bound the log's quota to `codex/xd` (plan `plus`, five-hour window 6% used, weekly 93% used, read from Cindy's `codex-home`),
  and every router output reports `accounts: [codex/xd, plus, ready]` and that quota block, including decisions routed to `anthropic/claude-sonnet-5-5` and `google/gemini-3.8-flash`, which spend gateway credit, not the Codex plan.
  The 0.1.121 fixture had a separate Codex connection with `providerId` `openai`.
- What it should have distinguished: a Codex-harness connection that authenticates with a Codex sign-in (whose log is the quota source) from the gateway connection that only offers the codex harness.
  Catalog rows carry no field for it besides `providerId`, so the plugin cannot tell.

## Cindy-side findings

1. Cancel does not interrupt a foreground shell command, and the cancelled run ends `failed` (0.1.121 reported `completed`).
2. Plugin installs are per account: after signing in, the plugin installed while signed out was gone and had to be installed again.
3. The plugin card's Working folder must equal the calling dialogue's own folder, or `roll` is `blocked`; the native folder dialog's autocomplete garbled long paths.
4. A prefs file with a UTF-8 BOM is ignored without a clear message.
5. A new dialogue's approval mode must be Full access, or the pack/install of a plugin is denied.
6. Agents of Cindy refuse to emit a 15 KB tool argument made of one repeated line.

## Not verified

- A Codex-only, Claude-only and Codex + Claude + Grok sign-in configuration: the run used the Cindy AI gateway, which serves every harness.
- Plugin 0.4.1 on real Cindy: the prefs-read removal and the re-vendored engine were not run there.
- Whether a Codex Pro or Pro100 account's five-hour window is handled as intended upstream.
- The agent transcripts in `acceptance.json` were pasted back by Cindy agents; the receipts and router outputs are the primary evidence.

During this run only `plugin/engine/route.mjs` changed under `plugin/`.
