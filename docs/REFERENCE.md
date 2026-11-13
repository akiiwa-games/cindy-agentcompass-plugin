# Plugin reference

What only this plugin has: its tools, two engines, profile contract, classifier, state files, safety boundary and tests. Scoring formulas, tie-breaks, quota
pricing and the account model belong to AgentCompass and are not repeated here: [technical reference](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/docs/technical-reference.md),
[router internals](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/skills/agent-compass/references/router-internals.md). The engine in `plugin/engine/` is pinned to
AgentCompass v0.6.0 plus `2844342` (a `needs_visual` task requires image input at every `tool_operation` level), as ported by [Magpie](https://github.com/akiiwa-games/magpie-agentcompass-router) `35a7aea` (0.2.1).

## Layout

| Path | What it is |
| :-- | :-- |
| `plugin/ghost.json` | Cindy v3 manifest: `minCindyVersion` `0.1.121`, `sessionContext`, `agent.tasks`, `cindy.text: ["oneshot"]`, a Node worker; four tools; `en`, `zh-CN`, `ja`, `ko` in `plugin/locales/` |
| `plugin/main.js` | Logic page: asks Cindy's quick-text channel to classify, picks the one catalog row that equals the route, creates and checks the draft, sends once, collects results |
| `plugin/worker.cjs` | Node worker: validates the host context, runs the engine or the external CLI, makes the launcher permission explicit, keeps receipts and message pages |
| `plugin/engine/route.mjs` | The plugin's own router around the engine: classifier prompt, schema and cache, split and self gates, ranking of catalog rows (no quota reading, no fast mode) |
| `plugin/engine/*.mjs`, `classifier-cases.json` | AgentCompass's engine modules and rubric, vendored unchanged by `scripts/vendor_engine.mjs <magpie checkout> [commit]` (reads that commit, never a working tree; `test/test_engine.mjs` pins the digests). They read no file and no environment variable |
| `scripts/build_plugin.py` | Optional: writes a plugin source directory bound to one external AgentCompass install |
| `scripts/cindy_0_1_121_cancel_hotfix.py`, `patches/cindy-0.1.121-cancel.patch` | Optional local fix for cancelling on Cindy 0.1.121 (see below) |

## Tools

| Tool | Arguments | Answer |
| :-- | :-- | :-- |
| `roll` | `task` (the whole assignment, unchanged); optional `profile` | `running` with `operation`, `task_id`, `run_id` and a `next_tool` call to `status`; or `split` (with `task_count`), `self`, `blocked`; `unknown_create`, `unknown_send`, `create_rejected`, `send_rejected` when Cindy's answer was lost or refused |
| `status` | `operation` | The run's state; collects every message page (up to ten per call) and the exact final message (`final_result_summary`, at most 4,000 characters, `summary_shortened`); `messages_complete` says all pages are read |
| `stop` | `operation` | Cancels, then polls up to ten seconds; `confirmed_terminal` only when Cindy reports a terminal state, otherwise the run is still `stopping` |
| `cleanup` | `operation` | `cleaned`, or `manual_cleanup_required` with the confirmed task ID when Cindy has no archive API, or `cleanup_refused` (with the tool to call next) while delivery is unconfirmed, a run is active, pages are unread, or the task cannot be verified |

Cindy supplies the trusted `session_context` (session, local workdir); a caller-supplied one is replaced. Remote or read-only workdirs and a missing context are refused before anything
is routed. A worker's task text plus the return-channel contract must fit Cindy's 32,768-character send limit; a longer one is refused, not cut.

## Engines

The worker re-reads its configuration on every request; the first match wins.

1. `router.json` next to `worker.cjs`, then `~/.agent-compass/cindy-plugin/router.json`: `{"command": [...complete roll command...], "accountMappings": [...], "stateRoot": "...", "timeoutMs": ...}`.
   The external CLI routes: `<command> --parent-host native --parent-id <session_id> --parent-address <session_id> --local-only "<reason>" --task - --verbose`.
2. `~/.agent-compass/cindy-plugin/config.json` with `{"engine": "cli"}`: the `agentcompass` on `PATH`, then in `~/.local/bin` (Windows: `agentcompass.exe` only). When it is not installed the built-in engine routes and
   the answer says so in `engine_note`. `{"engine": "builtin"}` is the same as no file.
3. Nothing (a market install): the built-in engine.

An unreadable `router.json` or `config.json` fails the call with the file named. The external CLI classifies for itself: a `profile` passed with it is refused (`profile_not_supported_by_cli`), and its
`scorer_unavailable` answer comes back as `blocked`. Its accounts are bound to Cindy connections by `accountMappings` in `router.json`, else `~/.agent-compass/cindy-plugin/account-map.json`
(`[{"routerProvider":"codex","routerAccount":"codex","providerId":"<Cindy connection ID>","agentKind":"codex"}]`, `agentKind` is `cc`, `codex` or `pi`), else a routed account needs a Cindy
connection of the same name. The built-in engine routes to catalog rows directly and needs no map. `scripts/build_plugin.py --output <new directory> [--router-cmd ...] [--account-map ...]` writes a
source directory with this bound; it installs nothing.

## Profile contract

The built-in engine routes only on a task profile, which comes from the classifier model or from an explicit `profile`; it never reads the task text for it. A profile states
`work_kind`, `interaction_style`, `reasoning_depth`, `code_complexity`, `axis_demand` (exactly `divergence`, `coding`, `aesthetics`, `tool_operation`, each an integer 0..3), `access`, `needs_visual`, `needs_gui`,
`local_only`, `wants_fast`, `read_only_review`, `expected_hours`, `hours_confidence`, `urgency`, `multi_task` and `task_count`; the classifier also states `self` and `reason`, which a caller may leave out.
An answer or `profile` missing a required field is refused, never defaulted. Fields of earlier AgentCompass versions (`context_scale`, `hallucination_risk`, `error_cost`, `realtime_loop`) are not read.

| `status` / `decision.reason` | Meaning |
| :-- | :-- |
| `blocked` / `invalid_caller_profile` | The `profile` is incomplete or invalid; nothing was classified or started |
| `blocked` / `invalid_classifier_output` | The model's answer is unparsable or fails the schema |
| `blocked` / `classifier_<code>` | Cindy refused the request: `classifier_no_candidate`, `classifier_timeout`, `classifier_rate_limited`, `classifier_permission_denied`, ...; `profile_source` is `unavailable` |
| `blocked` / `classifier_cooling_down` | A recent failure holds the retry (below) |
| `blocked` / `task_too_long_for_classifier` | The task does not fit the classifier prompt; give a `profile` |
| `blocked` / `no_runnable_model` | The catalog has no Claude, Codex or Pi model |
| `blocked` / `no_route` | No row can run the task; `decision.excluded` gives one line per reason with the rows it removes |
| `blocked` / `accounts_unavailable` | Only from an external AgentCompass CLI: every account it knows is excluded; `accounts` and `warnings` say why. The built-in engine has no accounts |
| `blocked` / `unsolicited_or_mismatched_classification` | A classification the worker did not ask for |
| `split`, `self` | The profile says several independent deliverables (`task_count`) or an answer for the current session; nothing starts |

`decision` also carries `profile_source` (`classifier`, `caller`, `unavailable`), `classifier_model`, `axis_demand`, `components`, `score`, `alternatives` and `warnings`; the built-in engine lists no quota or account. It is saved with the
receipt as `router.stdout.json`.

## Classifier

- **The request.** One `cindy-request` of kind `oneshot_text` with `expectJson`, no model named: Cindy picks the model (the plugin card's, else the auxiliary chain). No Agent, tools, task or session is
  involved, so nothing reaches the task list. It spends the user's model quota, including when the answer is `split` or `self`. `decision.classifier_model` records what answered.
- **The prompt.** AgentCompass's `SCORER_PROMPT` without its CRITICAL RULES 2-5, the rubric and route definitions from `classifier-cases.json`, calibration cases, the schema, and the whole task in an
  `untrusted_task_evidence` envelope. The channel takes at most 32,768 characters. The rubric always goes whole; calibration cases take what is left, whole ones only, in an order computed from the case
  file alone (`calibrationCaseOrder`): the `multi_task` case, one case of each `reasoning_depth` and of each `axis_demand` level (rarest first), then one per `work_kind`. 63 of the 66 cases fit a short task. A task
  longer than about 19,800 characters once JSON-escaped is refused with `task_too_long_for_classifier`. `decision.classifier_calibration_cases` records `{included, total}`.
- **Validation.** The answer must satisfy `TASK_PROFILE_SCHEMA` with every field present; `task_count` is a JSON string (a positive whole number is read as its bucket `1`, `2`, `3` or `>3` and checked like the string);
  `expected_hours` is `0.05..24`; a `reason` over 300 characters is truncated.
- **Cache.** Answers are kept in memory and in `score-cache.json`, keyed by prompt digest and full task input, for 10 minutes by default; a model changed on the plugin card is picked up by the next classification after that.
- **Cooldown.** After a failed classification `roll` answers `classifier_cooling_down` at once for 30 s, doubling to 5 min per consecutive failure (`classifier-cooldowns.json`). `classifier_no_candidate` and
  `classifier_permission_denied` hold up every task, `classifier_rate_limited` none, others only that text. A successful classification clears it, and so does a change of `oneshotModel` or of the catalog. A fix the plugin cannot see (another model on the plugin card, the auxiliary model, a permission) waits out the cooldown, at most 5 minutes; the plugin does not read Cindy's `owners/*/ghost-errand-prefs.json`, which is Cindy's private app data. Cached tasks and explicit profiles are never held up.
- **Configuration** (`~/.agent-compass/cindy-plugin/config.json`, all optional, validated on every request): `classifierTimeoutMs` (integer 100..65000, default 65000), `classifierCacheTtlMs` (integer
  0..86400000, default 600000; 0 disables cache hits), `stateRoot` (non-empty string). Model keys of earlier versions are ignored: the model is chosen on the plugin card.

## Routing around the engine

- **Native.** `selectBestRoute` scores every Claude, Codex and Pi row with each effort the row offers, from the profile; the best net score starts. Where one model at one effort is offered by both Pi and its native CLI at
  the same score, the harness order of the work kind decides.
- **Data gaps.** A row with missing category scores, an unpriced billed account or unknown capacity leaves automatic routing and is listed in `decision.excluded`; naming the model (`constraintModel` / `pinnedModel`,
  `constraintEffort` in `routeTask`) dispatches it with a `data error:` warning. The `roll` tool takes no such argument today.
- **No quota.** The built-in engine reads no quota and no file of Cindy's or of any Codex home. A quota reading belongs to the account it was read from, and the catalog gives only a `providerId` per row: it cannot tell the
  user's own Codex sign-in from the Cindy AI gateway (on a signed-in Cindy 0.1.135 all 84 rows were `xd`; on 0.1.121 signed in to Codex only they were `openai`), so the local Codex log, which is the quota of the user's own
  sign-in, would have been attached to the gateway. Every row therefore runs on the engine's built-in unmetered gateway account, with no plan, window, capacity or price, and is ranked by capability fit; nothing leaves
  automatic routing for a quota reason and a decision lists no `accounts`. This stays until Cindy offers connection kind and quota through its plugin API.
- **Fast mode.** Never chosen: it needed a quota reading attached to the Codex sign-in's own connection. `wants_fast` stays in the profile and in `decision.wants_fast` as the classifier or caller stated it; `bundle.fast` is
  always `false`. (An external CLI may still return a fast bundle; the plugin starts it only on a row that offers fast mode.)
- **Refused routes cool down.** When `tasks.create` refuses because of the route (`ROUTE_UNAVAILABLE`, `UNSUPPORTED_CAPABILITY`, `PERMISSION_DENIED`), that route is skipped for 15 minutes, doubling per consecutive
  refusal up to 2 hours (`route-cooldowns.json`; `decision.cooling_down`). When every runnable route is cooling down the roll still routes and sets `cooldown_warning`.
- **Not carried from AgentCompass.** User scores and pricing configuration, quota readings and account states, metered (billed) accounts, a `--constraint` or `--effort` option on `roll`, continuity between rolls, and AgentCompass's own account fleet (the
  accounts are the Cindy connections).

## Safety boundary

- Only Cindy's injected `session_context` identifies the parent. The built-in engine routes only to this Cindy's catalog and the external CLI is told `--local-only`, so no remote worker starts.
- No substitution: harness, connection, model, effort, fast support and permission are checked against `tasks.models()` before create and against `resolvedConfig`, permission, plan state and directory after it. A draft
  that does not match gets no input and is archived, or handed back for manual archiving. Only the `claude`, `codex` and `pi` harnesses run; Claude is `bypassPermissions`, Codex and Pi `full-access`; an explicitly
  different mode is refused. Cindy creates every task with `permissionMode: "bypassPermissions"`; only workers are created.
- Idempotent: one operation per session and task, stable create and send request keys, a durable receipt in `~/.agent-compass/cindy-plugin/<operation>/`, one lock per operation. A send with a lost answer is reconciled through
  `listRuns` and a run is claimed only when its input message carries this prompt. If a receipt cannot be saved after an accepted send, `roll` still returns `operation`, `task_id`, `run_id` and `receipt_saved: false`.
  For `unknown_create` a possible orphan draft cannot be identified: inspect the plugin's tasks in Cindy.
- Cindy 0.1.121 needs `models`, `create`, `send`, `get`, `getRun`, `listRuns`, `readMessages`, `cancel`, `exactRoute` and `createPermissionMode`; `archive` is optional. Older hosts are unsupported; there is no native fallback.
- Full output stays on disk; only a bounded summary returns to the session. No private IPC.

## Cancelling on Cindy 0.1.121

Cindy 0.1.121's cancel is a graceful stop: it does not interrupt a foreground command already running, and a cancelled run is reported as `completed`. `patches/cindy-0.1.121-cancel.patch` is the upstream source fix.
`scripts/cindy_0_1_121_cancel_hotfix.py "<Cindy>/resources/app.asar" --action check|apply|restore` applies the compiled counterpart to a closed Windows install: it changes only the reviewed member of `app.asar` and its integrity
data, keeps byte-exact backups, and changes nothing on any version or content mismatch. The result is a locally modified build (the vendor signature no longer verifies); the plugin works on the stock build without it.

## Tests

```sh
npm test                    # node --test: market gate, engine, logic page, worker bridge; python -m unittest: build script, hotfix refusals
npm run test:sandbox        # test/sandbox-e2e.mjs: isolated home, fake Cindy host, real worker.cjs, both engines
npm run test:sandbox:linux  # the same plus the unit tests in the WSL docker-desktop distro (musl Node and Python in a /run tmpfs)
```

`test/test_market_contract.mjs` checks `plugin/` against the market repository's gate: the pinned Cindy manifest validator (vendored unmodified under `test/vendor/`), id, version, tools, icon, locales, and that the engine imports only
Node built-ins and package files. The unit tests assert rules (exact catalog rows, gates, no quota or Codex-home read, fast mode never chosen), not a chosen winner, and a scan test forbids any read of task text outside a counted list of reasons. `npm test`
also compares `engine/classifier-cases.json` with the AgentCompass file it pins (2844342), at `AGENTCOMPASS_CHECKOUT` or a checkout found next to the repository. The sandbox substitutes only the Cindy host
(`test/zero_cindy_host.mjs`, fed the catalog a real Cindy 0.1.121 reported), the model behind the CLI's classifier and discovery placeholders for provider CLIs; it runs with the CLI's public-data refresh off, so it makes no
network request. Its latest Windows and Linux runs are in `docs/sandbox-e2e-report.json` with every scenario's input and host record under `docs/sandbox-artifacts/`; `npm run test:sandbox:linux` updates its own part, and
`CINDY_REPORT_MERGE_INTO=docs/sandbox-e2e-report.json npm run test:sandbox` the Windows one (copy its artifacts by hand).

Run records: [real Cindy 0.1.135 signed in, plugin 0.4.0: the quick-text classifier and the v0.6.0 engine](real-cindy-0.1.135-plugin-0.4.0/README.md); release notes in [CHANGELOG.md](../CHANGELOG.md), [real Cindy 0.1.121, plugin 0.3.0](real-cindy-0.1.121/README.md) and [the setup gate of the quick-text classifier, signed out](sandbox-real-e2e/README.md). The scripts that drive a real-Cindy run are in [`test/real-cindy/`](../test/real-cindy/README.md). A Codex-only, Claude-only and Codex + Claude + Grok sign-in configuration has not been run on real Cindy.
