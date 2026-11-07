# cindy-agentcompass-plugin

A [Cindy](https://github.com/makecindy/cindy) plugin that lets a Cindy session hand work to an AgentCompass route and get the exact
result back. The plugin carries its own copy of the [AgentCompass](https://github.com/akiiwa-games/AgentCompass) routing engine: it
profiles the task, decides whether it should be split, done in the session itself or delegated, picks the harness, model, effort and
fast mode from the models this Cindy can actually run, starts that route as an ordinary Cindy task, checks that Cindy really runs what
was routed, and collects the task's final message. Every delegated child task is created with `bypassPermissions` (Claude) or `full-access` (Codex, Pi) in the parent session's project directory regardless of the parent session's own mode, and the built-in router reads the tail of local Codex session logs (`~/.codex` and Cindy's `codex-home`) for quota, and the `errand` map of Cindy's `owners/*/ghost-errand-prefs.json` to notice a change of the model on the plugin card (keeping only a digest).

Installing it from the plugin market is enough, once Cindy is signed in to a Cindy account (see the next section). It needs nothing else on the
machine: no AgentCompass install, no Python, no network service and no npm dependency. A machine that does have the AgentCompass CLI can switch the
plugin over to it (see [Engines](#engines)).

## A Cindy account is required

**Sign in to a Cindy account before using this plugin.** While Cindy is signed out, every tool of the plugin, `roll`, `status`, `stop` and `cleanup`
alike, stops at a Setup card ("AI 模型服务", with 打开模型设置 and 取消). Cancelling answers `SETUP_CANCELLED` and the plugin does not run at all, even with
an explicit `profile`. Codex, Claude and Grok sign-ins do not count, even when Cindy's agents run on them. This was measured on real Cindy 0.1.121
([evidence](docs/sandbox-real-e2e/README.md)).

The cause is on Cindy's side and the plugin cannot opt out: the live classifier needs `cindy.text` in the manifest, and Cindy requires its own
account for any plugin that declares a `cindy` capability, on every tool. Two things there do not line up
([draft upstream issue](docs/sandbox-real-e2e/upstream-issue-draft.md)): the card speaks of image or video capabilities although this plugin only uses
text, and `ghosts.setupStatus` answers `ready: true` while `ghost_call` is stopped.

## How it works

```text
Cindy session ──ghost_call {tool:"roll", args:{task}}──▶ plugin/main.js (Cindy logic page)
                                                           │  Cindy injects the trusted session_context;
                                                           │  the live catalog comes from cindy.tasks.models()
                                                           ▼
                                                 plugin/worker.cjs (Cindy node bridge, JSON-RPC over stdio)
                                                           │  built-in engine (plugin/engine/), or the configured
                                                           │  `agentcompass roll --parent-host native ... --local-only`
                                                           ▼
                                   split / self ◀── gates ── profile → score every catalog route → one exact route
                                                           │
                                   harness/permission made explicit, Cindy return channel appended, receipt saved
                                                           ▼
             cindy.tasks: create (exact route, bypassPermissions) → verify draft → send (expectedRevision)
                                                           │
             status → getRun / readMessages (every page saved on disk) → exact outputMessageId → final report
```

- `plugin/ghost.json`: Cindy v3 manifest (`minCindyVersion: "0.1.121"`, `sessionContext`, `agent.tasks`, `cindy.text`, a Node worker)
  with four tools: `roll` (accepting `task` and an optional explicit `profile` override), `status`, `stop`, `cleanup`; the icon
  `plugin/assets/icon.png` (from `scripts/make_icon.mjs`) and `en`, `zh-CN`, `ja`, `ko` resources in `plugin/locales/`, as the official
  plugin repository requires.
- `plugin/engine/`: the built-in router. `route.mjs` holds the live model classifier prompt/schema/validator/cache, the profile-driven
  split and self gates, the catalog scoring, the quota reading and fast mode; `catalog.mjs`, `profiler.mjs` and `allocator.mjs` are the
  AgentCompass model catalog, profile schema validator and allocator (MIT, vendored); `classifier-cases.json` is the AgentCompass rubric and
  calibration set, unchanged.
- `plugin/main.js`: the logic page. Requires the experimental tasks API, puts the classification to Cindy's quick-text channel when the
  built-in engine needs a live task profile, picks the one catalog route that exactly matches the routed
  harness/connection/model/effort/fast setting, creates and checks the draft, sends the full prompt once, and collects results.
- `plugin/worker.cjs`: the node bridge. Validates the host context, coordinates the two-step built-in classification and routing, turns the
  route into an explicit Cindy contract (only `claude`, `codex`, `pi`; Claude `bypassPermissions`, Codex and Pi `full-access`; an explicitly
  different mode is refused), appends the return-channel contract, and keeps durable receipts and message pages under
  `~/.agent-compass/cindy-plugin/`.
- `scripts/build_plugin.py`: writes a plugin source directory bound to one external AgentCompass install (optional).
- `scripts/cindy_0_1_121_cancel_hotfix.py` and `patches/cindy-0.1.121-cancel.patch`: the opt-in local fix for cancellation on Cindy 0.1.121.

## The built-in engine and live classifier

`roll` routes the complete task, unchanged, against the catalog Cindy reports for this machine (`tasks.models()`). All task profile fields
(`work_kind`, difficulty integers, `multi_task`/`task_count`, `needs_visual`, `needs_gui`, `local_only`, `realtime_loop`, `self`,
`wants_fast`) come strictly from the live classifier model's semantic judgment or an explicit caller-supplied `profile`—never from
keyword, regex or length heuristics on the task text:

- **live model classification**: when no caller `profile` is supplied and the task input is not already cached, the logic page makes one
  request on Cindy's quick-text channel (`cindy.send({type:'cindy-request',kind:'oneshot_text',expectJson:true})`, manifest
  `cindy.text: ["oneshot"]`): one model request with no Agent, no tools, no task and no session, so nothing appears in the task list. It
  spends the user's model quota, including when the answer is `split` or `self`. **Cindy chooses the model**: the one picked on the plugin
  card, else the manifest's `oneshotModel` (this plugin sets none), else the auxiliary chain in Cindy settings. The plugin cannot name it and
  learns it from the answer (`classifier_model`). Cindy runs this channel on its Cindy account (`xd`), OpenAI, xAI and Anthropic API-key
  connections; a Claude subscription adds no quick-text model.
- **the prompt**: the AgentCompass `SCORER_PROMPT` without its CRITICAL RULES 1-5 (each one repeats, more briefly, an entry of the rubric that follows),
  then `plugin/engine/classifier-cases.json` (the AgentCompass file `skills/agent-compass/references/classifier-cases.json`, unchanged: route
  definitions, rubric, 47 calibration cases; `test/fixtures/agentcompass/` holds the copy `npm test` compares it with), the schema as one entry per field
  with every constraint and description, and last the whole task inside an `untrusted_task_evidence` JSON envelope with prompt-injection rules. The
  answer is validated against `TASK_PROFILE_SCHEMA` with every field required, so one without `self` or `wants_fast` is `invalid_classifier_output` and
  starts nothing (including `realtime_loop` and `expected_hours` in `0.05..24`), and cached in memory and in
  `~/.agent-compass/cindy-plugin/score-cache.json`, keyed by prompt/schema digest and full task input.
- **the 32,768-character budget**: this channel takes a single `prompt` of at most 32,768 characters and has no separate context field, so the
  task and the instructions share it. The rubric and route definitions always go whole; calibration cases take what is left, whole ones only, in
  an order computed from the fields of the case file alone (`calibrationCaseOrder`), never from what the task says: the `multi_task` case, a live case
  paired with a counterexample that writes or fixes code, one case of each `reasoning_depth` rarest first, then the other pairs (a live case never goes in
  without its counterexample), the rest of the rarest depths, and one of each `work_kind` in turn. All 47 fit a task of up to about 6,200 characters;
  33 at 10,000, 21 at 15,000, 10 at 17,000, 6 at 18,000. Every one of those signals is there up to about 18,250 characters; above that, whatever still fits goes in, in that
  order, so depth 3 goes first, a live pair at about 18,900, `multi_task` at about 19,350 and depth 4 last. `decision.classifier_calibration_cases` records `{included, total}`. A task
  that does not fit with no cases left (about 19,700 characters once JSON-escaped) is refused with `task_too_long_for_classifier`, never cut; give it
  an explicit `profile`.
- **when the classifier is unavailable**: on any failure the built-in engine **never** falls back to keyword profiling. It returns
  `status: "blocked"` with `profile_source: "unavailable"`, a `decision.reason` of `classifier_<Cindy's code>` (`classifier_no_candidate`,
  `classifier_timeout`, `classifier_rate_limited`, ...) or `invalid_classifier_output`, no `prepared` receipt, and a `next_action` saying the model
  can be changed on the plugin card (for `classifier_rate_limited`, Cindy's limit on requests in flight, to roll again shortly). An existing receipt is
  left in place.
- **a failed classification cools down**: Cindy chooses the model, so a retry cannot go elsewhere. For 30 s, doubling to 5 min with each
  consecutive failure, `roll` answers at once with `classifier_cooling_down`, the original failure, the wait and what else works, without asking Cindy
  (`classifier-cooldowns.json` in the state directory). `classifier_no_candidate` and `classifier_permission_denied` say the channel cannot answer and
  hold up every task. Any other failure (`INTERNAL`, `TIMEOUT`, a malformed answer) may be that task's doing and holds up only that task's text, in every
  session. `classifier_rate_limited` holds up nothing. A classified task clears it, and so does any change of what picks the model: the card, `oneshotModel`
  or the catalog. The card has no API, so that one is seen through `errand` in `<app data>/owners/*/ghost-errand-prefs.json`, an undocumented Cindy file; if
  Cindy changes it, the cooldown just runs out. No wait is longer than 5 minutes, even with the clock moved back. Cached tasks and explicit profiles
  are not held up.
- **an explicit `profile`** must give every field in the tool schema's `required` list, otherwise `invalid_caller_profile` and nothing starts;
  `profile: null` is the same as no profile.
  The external CLI classifies for itself and takes no profile: passing one answers `profile_not_supported_by_cli`.
- **split**: when the profile has `multi_task: true`, `roll` returns `status: "split"` with `task_count`; nothing starts. Roll each task
  separately.
- **self**: when the profile has `self: true` (or `delegate: false`), `roll` returns `status: "self"`; nothing starts.
- **native**: otherwise the allocator (`rankCandidates`) scores every Claude, Codex and Pi row with each effort the row offers against the
  profile. The best one is started. Where one model is offered by both Pi and its native CLI, Pi wins for read-and-report work and the
  native CLI otherwise, as in AgentCompass. `realtime_loop` is preserved on both `profile` and `decision`.
- **quota**: the newest rate-limit snapshot the Codex CLI wrote to its session logs (`$CODEX_HOME`, else `~/.codex` and Cindy's own
  `<app data>/CindyGlobal/codex-home`) lowers the score of routes on that connection when it is high or exhausted. The decision lists
  `quota_penalized_routes` and warns when the chosen route itself is short of quota.
- **fast mode**: a task whose profile sets `wants_fast: true` (or `urgency: "high"`) gets Codex fast mode when the row supports it and the
  quota snapshot shows less than 60% used. Unknown quota never turns fast mode on.
- **refused routes cool down**: when Cindy refuses `tasks.create` because of the route itself (`ROUTE_UNAVAILABLE`,
  `UNSUPPORTED_CAPABILITY`, `PERMISSION_DENIED`), that route is skipped for 15 min, doubling with each consecutive refusal up to 2 h,
  so the retry goes elsewhere (`route-cooldowns.json` in the state directory; the decision lists `cooling_down`). A task created on
  the route clears it. When every runnable route is cooling down, the roll still routes and warns (`cooldown_warning`).
- **blocked**: a catalog with no Claude, Codex or Pi model, an unavailable/failed classifier without a caller profile, or no route that
  meets the task's floor, is refused (`status: "blocked"`); nothing is guessed.

Every decision is saved with the receipt (`router.stdout.json`): `profile_source` (`"classifier"`, `"caller"` or `"unavailable"`),
`classifier_model`, `realtime_loop`, `profile`, chosen route, score components, alternatives and quota.

### Classifier configuration (`~/.agent-compass/cindy-plugin/config.json`)

All classifier fields in `config.json` are optional. The model is not one of them: pick it on the plugin card.

- `classifierTimeoutMs` (`integer`, `100..65000`, default `65000`): how long the logic page waits for Cindy, which itself answers within 60 s.
- `classifierCacheTtlMs` (`integer`, `0..86400000`, default `600000`): TTL in milliseconds for cached profiles in `score-cache.json` (`0`
  disables cache hits).

`classifierModel`, `classifierModels` and `classifierEffort` of earlier versions are ignored.

## Engines

The worker reads its configuration again on every request; the first match wins:

1. `router.json` next to `worker.cjs` (written by `scripts/build_plugin.py`), then `~/.agent-compass/cindy-plugin/router.json`:
   `{"command": [...complete roll command...], "accountMappings": [...], "stateRoot": "..."}`. The external CLI routes:
   `<command> --parent-host native --parent-id <session_id> --parent-address <session_id> --local-only "<reason>" --task - --verbose`.
2. `~/.agent-compass/cindy-plugin/config.json` with `{"engine": "cli"}`: the `agentcompass` on `PATH`, then in `~/.local/bin` (Windows:
   `agentcompass.exe`, `%USERPROFILE%\.local\bin`). If it is not installed the built-in engine routes and the answer says so in
   `engine_note`. `{"engine": "builtin"}` is the same as no file.
3. Nothing (a market install): the built-in engine.

An unreadable `router.json` or `config.json` fails the call with the file named; nothing is routed. With the external CLI, Cindy
connection bindings come from `router.json`, else from `~/.agent-compass/cindy-plugin/account-map.json`
(`[{"routerProvider":"codex","routerAccount":"codex","providerId":"<Cindy connection ID>","agentKind":"codex"}]`, `agentKind` is
`cc`, `codex` or `pi`), else a routed account needs a Cindy connection of the same name. The built-in engine routes to catalog rows
directly and needs no mapping.

## Install and use

1. Install the `agentcompass` plugin in Cindy and approve Node, sessionContext and tasks.
2. On the plugin's page set **Write access** to **Full access** and **Working folder** to the project being delegated.
3. Delegate: `ghost_call` with `{"ghost_id":"agentcompass","tool":"roll","args":{"task":"<complete task unchanged>"}}`.
4. Call the `next_tool` it returns (`status`) until the run is terminal **and** `messages_complete` is `true`. There is no automatic
   callback. A terminal run whose pages are not all read yet keeps pointing at `status`.
5. Call `cleanup`. Cindy 0.1.121 has no archive API, so it answers `manual_cleanup_required` with the confirmed task ID: archive that
   task from the task list.

`stop` cancels the run and waits up to ten seconds for Cindy to confirm a terminal state (`confirmed_terminal`). `cleanup` refuses
(`cleanup_refused`, with the tool to call next) while delivery is unconfirmed, while any run of the task is active, before every message
page is read, and whenever it cannot verify the task.

To bind one external AgentCompass install instead, build a source directory and install that:

```sh
python -X utf8 scripts/build_plugin.py --output <new-absolute-directory> [--router-cmd <agentcompass|checkout|JSON command>] [--account-map map.json]
```

The build installs nothing and refuses an existing output directory. In Cindy use `ghost_forge_pack({dir:"<plugin source>"})` and the
official installation flow.

Setup details, the support boundary, the real acceptance on Cindy 0.1.121 and the cancel fix:
[docs/CINDY_REAL_ACCEPTANCE_AND_CANCEL_FIX.md](docs/CINDY_REAL_ACCEPTANCE_AND_CANCEL_FIX.md).

## Safety boundary

- Only Cindy's injected `session_context` identifies the parent; a caller-supplied one is replaced by the host. Remote or read-only
  workdirs and missing context are refused before anything is routed.
- The worker runs as a Cindy task in the local project: the built-in engine routes only to this Cindy's catalog, and the external CLI is
  told `--local-only`, so no remote worker is ever started. `split`, `self` and blocked answers come back unchanged and start nothing.
- No substitution: a model, connection, effort or permission Cindy cannot reproduce exactly is refused, never widened. A draft with the
  wrong route, permission or directory receives no input and is archived (or handed back for manual archiving).
- Idempotent and honest: one operation per session and task, stable request keys. A send whose answer was lost is reconciled through
  `listRuns` and claimed only when the run's input message carries this prompt; it is never resent. A definite refusal is recorded as
  `send_rejected` and its draft archived. `stopping` is not reported as stopped; cleanup never claims an archive that did not happen.
- Concurrency: each operation has its own lock, so a slow route in one session never blocks another session's calls.
- No private IPC, no credentials, no model API of its own; full output stays on disk and only a bounded summary returns to the session.

## Tests

```sh
npm test                    # node: market gate, engine, plugin boundary, real worker.cjs bridge; python: build script, hotfix refusals
npm run test:sandbox        # end-to-end in an isolated home: market install -> fake Cindy host -> real worker.cjs -> both engines
npm run test:sandbox:linux  # the same plus unit tests in the WSL docker-desktop distro, in a /run tmpfs with musl Node and Python
```

`test/test_market_contract.mjs` checks `plugin/` against the makecindy/cindy-official-plugins CI gate: the pinned Cindy
`validateGhostManifest` (vendored unmodified under `test/vendor/`, Apache-2.0) plus the repository's id, version, tool, icon,
locale and package rules, and that the engine imports only Node built-ins and package files.

`test/sandbox-e2e.mjs` substitutes only the Cindy host (`test/zero_cindy_host.mjs`, fed the catalog a real Cindy 0.1.121 reported, and
answering the quick-text channel with a fixture profile), the model behind the external router's classifier (a local OpenAI-compatible fixture) and discovery placeholders for provider CLIs. Everything
else runs for real: the market install with nothing else on the machine; the built-in engine producing Codex, Claude and Pi routes,
`split`, `self`, fast mode and quota moves from real Codex telemetry files; the external `agentcompass roll` when opted in, and the
built-in fallback when the CLI is missing; concurrent rolls across sessions, a forged `session_context`, 12 message pages, a 2.6 MB reply,
stop to a confirmed `cancelled` state, archive and `manual_cleanup_required` cleanup, drafts that fail verification, and PR #274
review cases 1, 2, 5, 6 and 7 end to end (all seven are unit-tested). Set `AGENTCOMPASS_CHECKOUT` to an AgentCompass checkout for the CLI scenarios (default `../route_manager`). The latest
Windows and Linux runs are in [docs/sandbox-e2e-report.json](docs/sandbox-e2e-report.json), with every scenario's input and host record
under `docs/sandbox-artifacts/`; machine paths are replaced by `<sandbox>`, `<repo>`, `<home>` and similar names.

The real Cindy 0.1.121 run in [docs/real-cindy-0.1.121/](docs/real-cindy-0.1.121/acceptance.json), with every tool call and answer, predates the
quick-text classifier. The classifier itself has not been covered on real Cindy, because that needs a Cindy account sign-in; only the fake-host suites
above and `npm test` cover it. See [docs/sandbox-real-e2e/](docs/sandbox-real-e2e/README.md).

## How AgentCompass fits with the other hosts

AgentCompass is the router: a profiler classifies each task, the allocator picks an owner/model/effort against live quota, and every
decision is recorded. Hosts own the sessions and the worker processes:

| Host | How work reaches AgentCompass | How the worker reports back |
|---|---|---|
| **Cindy** (this plugin) | the plugin's `roll` tool → the built-in engine, or `agentcompass roll --parent-host native` | the Cindy task's final message, collected with `status` |
| **Paseo** | `agentcompass roll` inside a Paseo agent (`PASEO_AGENT_ID`); AgentCompass launches the worker through Paseo | the worker messages its parent agent; AgentCompass notifies completion |
| **Herdr core** | `agentcompass roll` inside an `hc` terminal (`HC_TERMINAL_ID`); AgentCompass starts an owned child terminal | `hc send <parent>` from the worker |
| **Magpie** | [`magpie-agentcompass-router`](https://github.com/akiiwa-games/magpie-agentcompass-router): a Magpie gateway plugin that applies AgentCompass's task profiling and allocation to model requests | in the Magpie request path (routing, not task dispatch) |

Raw shell `roll` inside Cindy is refused by AgentCompass, because a Cindy shell exposes no addressable parent; use this plugin instead.

## License

MIT
