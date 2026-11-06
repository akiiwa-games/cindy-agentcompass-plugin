# Cindy: setup, support boundary, real acceptance and the 0.1.121 cancel fix

This document carries the Cindy material that used to live in AgentCompass (`skills/agent-compass/references/herdr-cindy.md`, its
real-acceptance report and the cancel-fix notes). The plugin now lives only in this repository and ships its own routing engine.

## What the plugin is now

- **Zero dependency.** `plugin/` installs from the market as is. Routing runs in the plugin's own Node worker with the built-in
  AgentCompass engine (`plugin/engine/`): the split and self gates, the AgentCompass profiler and allocator over the live
  `tasks.models()` catalog, Codex quota telemetry and fast mode. Nothing else has to be installed: no AgentCompass, no Python, no npm
  package, no network service.
- **Classification through Cindy's quick-text channel.** Task profiles come only from a model or an explicit `profile`. The logic page makes
  one `oneshot_text` request (manifest `cindy.text: ["oneshot"]`): no Agent, tools, task or session, so nothing reaches the task list; it
  spends the user's model quota. Cindy chooses the model: the plugin card's, else the auxiliary chain. Cindy runs this channel on its xd,
  OpenAI and xAI connections, so a Claude subscription alone answers `NO_CANDIDATE` and `roll` is blocked until a model is available or the
  caller passes a complete `profile`. The channel takes one prompt of at most 32,768 characters with no context field, so a long task costs
  calibration cases (47 up to about 3,800 characters, 6 at 15,000; recorded in `decision.classifier_calibration_cases`) and one that cannot
  fit is refused, never cut. The README has the details.
- **Two engines.** The external `agentcompass roll` is used only when the user asks for it: a `router.json` (written by
  `scripts/build_plugin.py`, or placed in `~/.agent-compass/cindy-plugin/`) binds one install, and `config.json` with
  `{"engine":"cli"}` uses the CLI found on `PATH` or in `~/.local/bin`. When that CLI is not installed the built-in engine routes and the
  answer carries `engine_note`. The external CLI is called as
  `agentcompass roll --parent-host native --parent-id <session_id> --parent-address <session_id> --local-only "<reason>" --task - --verbose`.
- **Harness contract.** The worker accepts only the `claude`, `codex` and `pi` harnesses, makes the launcher permission explicit (Claude
  `bypassPermissions`, Codex `full-access`, Pi's fixed full-tool worker as `full-access`), refuses an explicitly different mode instead
  of widening it, and appends the Cindy return-channel contract to the worker prompt. Cindy creates every task with
  `permissionMode: "bypassPermissions"`; the only tasks created are workers.
- **Pass-through answers.** `split`, `self` and blocked answers return to the Cindy session unchanged and start no Cindy task.
- AgentCompass keeps one Cindy-aware guard: raw shell `roll` inside a Cindy shell (its `CINDY_*` markers, no `--parent-host`) is refused,
  so a provider thread or the askpass route is never used as a Paseo parent. The sandbox run checks it.

## First-time setup

The stock shell is insufficient: `CINDY_INPUT_HANDOFF_ROUTE` is an opaque askpass capability, not a session ID, and Pi deliberately strips
`CINDY_PI_SESSION_ID` from bash children. The plugin declares `sessionContext:true`, so Cindy gives it the actual parent session and local
workdir; Cindy strips a caller-supplied `session_context` before injecting its own. Callers supply only the task.

1. Install the `agentcompass` plugin (market, or `ghost_forge_pack({dir:"<plugin source>"})` and the official installation flow) and
   approve Node, sessionContext and tasks.
2. On the plugin page set **Write access** to **Full access** and **Working folder** to the project being delegated. These are setup
   steps, not per-task arguments; the plugin refuses a task whose directory does not match the calling session's workdir.
3. Delegate through `ghost_call`:

   ```json
   {"ghost_id":"agentcompass","tool":"roll","args":{"task":"<complete task unchanged>"}}
   ```

4. Optional, external CLI: build a bound source directory with
   `python -X utf8 scripts/build_plugin.py --output <new-absolute-directory> [--router-cmd <json-or-path>] [--account-map <file>]`, or
   write `config.json` as above. `--router-cmd` is the whole roll command as a JSON array, an `agentcompass` executable, or an
   AgentCompass checkout. A Cindy connection whose ID differs from the router account needs an explicit map
   (`[{"routerProvider":"codex","routerAccount":"codex","providerId":"<exact Cindy connection ID>","agentKind":"codex"}]`); the mapping
   is a connection binding, not permission to change the routed account. The built-in engine routes to catalog rows directly and needs
   no map.

## Support boundary and completion

The plugin declares `minCindyVersion: "0.1.121"` and requires the runtime capabilities
`models/create/send/get/getRun/listRuns/readMessages/cancel`, `exactRoute:true` and `createPermissionMode:true`. `archive` is optional:
0.1.121 does not expose it. Older hosts without the core capabilities are unsupported; there is no invented native fallback. Cindy's
runtime reports the tasks API as experimental.

The plugin checks exact harness, connection, model, effort and fast support against `tasks.models()`, and after create checks
`resolvedConfig`, permission, plan state and the exact project directory before sending input with the task's `expectedRevision`. A
rejected draft is archived through the public API when available; otherwise its confirmed ID and manual cleanup instructions are returned.
Creating a draft never means launched. Task plus the appended return contract must fit Cindy's 32,768-character send limit; oversized
tasks are rejected without truncation.

Each assignment has stable create/send request keys and a durable operation receipt (`~/.agent-compass/cindy-plugin/<operation>/`). Each
operation has its own lock; other sessions are never blocked. A send whose answer was lost (`sending` or `unknown_send`) is reconciled
through `listRuns` and a run is claimed only when its input message carries this prompt; nothing is resent. A definite refusal
(`REVISION_CONFLICT`, `TASK_BUSY`, `INVALID_REQUEST`, …) with no run is recorded as `send_rejected` and its draft archived or handed back.
If the receipt cannot be saved after an accepted send, `roll` still returns the `operation`, `task_id` and `run_id` with
`receipt_saved:false`. For `unknown_create` the public task list does not expose the create request key, so a possible orphan draft cannot
be identified safely: inspect the plugin's tasks in Cindy and archive the confirmed idle draft there.

There is **no automatic completion callback**. `roll` returns an exact `next_tool` call to `status`. Status reads `getRun`, paginates
`readMessages` (up to ten pages per call), saves every page on disk and selects the exact `outputMessageId` for this run. Poll until the
run is terminal **and** `messages_complete` is `true`; until then `next_tool` stays `status`. Workers return questions as
`BLOCKED / needs_input` and their final report as a final assistant reply; the parent collects them through status.

`stop` reconciles, calls scoped `tasks.cancel`, then polls `getRun` for up to ten seconds and reports `confirmed_terminal`. `stopping`
or `reconciling` is never reported as stopped. `cleanup` reconciles first and refuses (`cleanup_refused`, with the tool to call next)
while delivery is unconfirmed, while any run of the task is active, before every message page is read, or when it cannot verify the
task. With archive it archives the confirmed inactive plugin-owned task and keeps history; without archive it returns
`manual_cleanup_required`, `archived:false` and the exact task ID.

Primary sources: [Cindy session context](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-session-context.md),
[Node protocol](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-node-worker.md),
[ordinary tasks API](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/docs/dev-rules/plugin-task-api-implementation.md),
[task slot capabilities and validation](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/apps/desktop/src/main/cindy-brain/taskSlot.ts).

## Real acceptance of plugin 0.3.0 on Cindy 0.1.121, 2026-11-03

Every tool call with its full answer, every receipt and router decision, and the screenshots are in
[real-cindy-0.1.121/](real-cindy-0.1.121/) (`acceptance.json`). Times below are UTC.

### Environment

- A fresh Windows Sandbox guest (user `WDAGUtilityAccount`), destroyed afterwards. The official Windows Cindy **0.1.121** global
  installer (SHA256 `6c8e485e4a200a5d41930dc74c3fbadcf23180bb1d886c3cda3b8a5ff056894b`), installed silently; Cindy's "skip login" path
  with the user's Codex and Claude sign-ins copied into the guest for this run only (Claude: access token only, no refresh token). No
  credential is recorded in the evidence.
- Zero configuration, probed before Cindy started: no `agentcompass` and no `python` on `PATH`, no `router.json` in the plugin, no
  `~/.agent-compass`. Node exists in the guest only as Cindy's own runtime and a CDP driver kept off Cindy's `PATH`.
- The plugin directory `plugin/` copied as is, installed by the Cindy agent with the official `ghost_forge_install` and later updated in
  place the same way. The installed files are hash-equal to `plugin/` (Cindy adds only its `.cindy-trust.json`).
- On the plugin page: Write access **Full access** (stored as `bypassPermissions`), Working folder the calling dialogue's folder.
- Every scenario was driven by asking the Cindy agent (GPT-6.1-Sol) to call the plugin's tools through `ghost_call`; the UI was operated
  over CDP.

### Results

| # | Scenario (task text) | Engine answer | Cindy task | Result |
|---|---|---|---|---|
| 1 | Review `stats.py` for correctness bugs (`debug_review`) | native: `claude` / `claude-opus-5-5` / `max` | run 08:35:23.8 → completed 08:36:58.3 | 4× running, then completed with `messages_complete:true`; the exact final report collected; cleanup `manual_cleanup_required` |
| 2 | Add a docstring to each function (`general_implementation`) | native: `codex` / `gpt-6.1-sol` / `high` | run 08:39:28.1 → completed 08:40:15.2 | completed, file changed as asked; cleanup `manual_cleanup_required` |
| 3 | Search the web for the IndexError docs (`web_research`) | native: `pi` / `chatgpt/gpt-6.1-terra` / `medium` | run 08:41:35.8 → completed 08:41:58.2 | completed with the quoted docs and URL; cleanup `manual_cleanup_required` |
| 4a | Two `Task 1:` / `Task 2:` deliverables | `split`, `task_count:"2"` | none | nothing started |
| 4b | "What does len() return for an empty list?" | `self` | none | nothing started |
| 5 | "Use fast mode: add a type hint …" | native: `codex` / `gpt-6.1-sol` / `high` / **fast `true`** | run 08:43:40.3 → completed 08:44:16.2 | quota read from Cindy's own Codex telemetry: 22% used (pro); completed; cleanup `manual_cleanup_required` |
| 6 | A long tutorial (4000 words, 30 examples) | native: `codex` / `gpt-6.1-sol` / `high` | run 08:45:12.7 | cleanup while running → `cleanup_refused` with `next_tool: stop`; stop at 08:45:23.0 → `confirmed_terminal:true`; run ended 08:45:25.4 |
| 7 | `config.json {"engine":"cli"}` with no CLI installed, then the question of 4b | `self` with `engine_note` naming the built-in fallback | none | `config.json` removed afterwards |

Every task was created with `permissionMode: "bypassPermissions"` and the exact catalog route; each run's `acceptedConfig` equals the
route. Each task's input message is the full task plus the return-channel contract. All five tasks were then archived from the Cindy
task list (task menu → Archive), as `manual_cleanup_required` instructs.

**Stop (scenario 6).** The run had sent one message and run one shell command; 2.4 s after `stop` it was terminal, `tutorial.md` was
never written and the collected final message is the worker's opening sentence. Cindy 0.1.121 labels that terminal state `completed`,
not `cancelled`; the plugin reports Cindy's status unchanged. Cindy's cancel is a graceful stop: the earlier acceptance below showed it
does not interrupt a foreground command that is already running. `patches/cindy-0.1.121-cancel.patch` and the hotfix script below are
the fix for that.

**Quota telemetry.** Cindy runs Codex with its own `CODEX_HOME` (`%APPDATA%\CindyGlobal\codex-home`), which the plugin process does
not inherit; the guest's `~/.codex` stayed empty. The engine therefore reads `$CODEX_HOME`, else both `~/.codex` and Cindy's codex home,
and takes the newest snapshot; fast mode in scenario 5 depends on it.

**Icon and languages.** The plugin list and detail page show the icon, `v0.3.0` and the description; the detail page shows the four
tools. With Cindy's display language set to English, 日本語, 한국어 and 简体中文 in turn, the description and the `roll` tool text appear
in that language (`locale-*.png`, `tool-roll-*.png`).

## The 0.1.121 cancel fix

`patches/cindy-0.1.121-cancel.patch` is the upstream source fix for graceful-only cancellation: plugin cancel interrupts the owned session
(`session.abort()`) instead of waiting for a graceful stop, and a cancelled terminal event is reported as `cancelled`. It touches
`apps/desktop/src/main/maker-ipc/register.ts`, `sessionEventTerminal.ts` and their tests.

`scripts/cindy_0_1_121_cancel_hotfix.py` applies the compiled counterpart to a **closed** Windows Cindy 0.1.121 installation:

```sh
python -X utf8 scripts/cindy_0_1_121_cancel_hotfix.py "<Cindy>/resources/app.asar" --action check
python -X utf8 scripts/cindy_0_1_121_cancel_hotfix.py "<Cindy>/resources/app.asar" --action apply
python -X utf8 scripts/cindy_0_1_121_cancel_hotfix.py "<Cindy>/resources/app.asar" --action restore
```

It changes only the reviewed member of `app.asar` and its integrity data (and the header hash embedded in `Cindy.exe`), keeps byte-exact
backups and restores from them. Any version, content or executable mismatch changes nothing. The result is a local modified build, not an
official release: the vendor signature is no longer valid after patching. The hotfix is optional; the plugin itself works on the stock
build, as the acceptance above was run. `test/test_cancel_hotfix.py` covers its refusals.

Hotfix contract:

- **Failure addressed.** A real cancel used the graceful stop, so a command already running still wrote its completion marker; replacing
  minified code of an arbitrary version could break the program.
- **Scope.** Only `app.asar` of a closed Cindy installation is modified; diagnostics, tests and official installs are untouched.
- **Decision rule.** The package version and the exact target member must equal the reviewed official 0.1.121 build; a hash proves equal
  content, not correct behaviour. The full original archive is kept; only the member and its integrity data change.
- **Recovery.** `apply` on the matching version; other versions are built from source; `restore` returns the verified original backup and
  never overwrites a newer version.
- **Degradation.** Read, write, parse or version mismatches replace nothing. An existing different backup is kept and reported.

## Earlier acceptance of the pre-split plugin, 2026-11-03

Before the plugin left AgentCompass, its earlier form (the AgentCompass 0.3.4 wheel with `--parent-host cindy`, external router only)
was accepted on the same Cindy 0.1.121 build in a Windows Sandbox with a Codex account:

- Install, real Codex sign-in, plugin pack/install/update, permission and working-folder setup, dispatch through `ghost_call`, exact
  routing (`codex / openai / gpt-6.1-sol / medium`), execution and exact result collection passed; the result file was exactly
  `CINDY_REAL_ACCEPTANCE_OK` (24 bytes). Two compatibility defects found there were fixed: the schemaVersion 3 manifest lacked
  `minCindyVersion`, and `archive` had been treated as required although 0.1.121 does not expose it.
- **Cancelling a running foreground command failed**: the run was accepted at 13:14:00.645 +08, the child wrote its start marker and
  began a 120-second foreground wait, `stop` at 13:14:50.371 +08 returned `stopping`, and at 13:16:09.008 +08 the host reported
  `completed` after the command wrote the marker file that must not exist after a cancel (22 bytes, SHA256
  `b6703b59c0006d0aceb58089183d4b7ca3d3abd79442bf84af8efda9e5311f9b`). That is the graceful-stop behaviour the cancel fix above
  addresses.
- Both tasks were archived through the Cindy menu; the sandbox was closed and no credential was copied into the evidence.
