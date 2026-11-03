# cindy-agentcompass-plugin

A [Cindy](https://github.com/makecindy/cindy) plugin that lets a Cindy session hand work to [AgentCompass](https://github.com/akiiwa-games/AgentCompass)
and get the exact result back. AgentCompass decides which account, model and effort should do the work; the plugin starts that route as an
ordinary Cindy task, checks that Cindy really runs what was routed, and collects the task's final message.

The plugin used to live inside AgentCompass. It is now separate: AgentCompass carries no Cindy plugin code and the plugin talks to it only
through its public `agentcompass roll` command.

## How it works

```text
Cindy session ──ghost_call {tool:"roll", args:{task}}──▶ plugin/main.js (Cindy logic page)
                                                           │  Cindy injects the trusted session_context
                                                           ▼
                                                 plugin/worker.cjs (Cindy node bridge, JSON-RPC over stdio)
                                                           │  agentcompass roll --parent-host native
                                                           │    --parent-id <session_id> --parent-address <session_id>
                                                           │    --local-only "<reason>" --task - --verbose
                                                           ▼
                                                 AgentCompass: classifier → allocator → ledger → native route
                                                           │
                         route_bundle + worker prompt ◀────┘
                                   │  harness/permission made explicit, Cindy return channel appended, receipt saved
                                   ▼
             cindy.tasks: models → create (exact route, bypassPermissions) → verify draft → send (expectedRevision)
                                   │
             status → getRun / readMessages (every page saved on disk) → exact outputMessageId → final report
```

- `plugin/ghost.json`: Cindy v3 manifest (`minCindyVersion: "0.1.121"`, `sessionContext`, `agent.tasks`, a Node worker) with four tools:
  `roll`, `status`, `stop`, `cleanup`.
- `plugin/main.js`: the logic page. Requires the experimental tasks API, picks the one catalog route that exactly matches the routed
  harness/connection/model/effort/fast setting, creates and checks the draft, sends the full prompt once, and collects results.
- `plugin/worker.cjs`: the node bridge. Validates the host context, calls the public router, turns its native route into an explicit Cindy
  contract (only `claude`, `codex`, `pi`; Claude `bypassPermissions`, Codex and Pi `full-access`; an explicitly different mode is refused),
  appends the return-channel contract, and keeps durable receipts and message pages under `~/.agent-compass/cindy-plugin/`.
- `scripts/build_plugin.py`: writes a reviewable plugin source directory with a `router.json` bound to one AgentCompass install.
- `scripts/cindy_0_1_121_cancel_hotfix.py` and `patches/cindy-0.1.121-cancel.patch`: the opt-in local fix for cancellation on Cindy 0.1.121.

## Install

1. Install AgentCompass (`uv tool install agentcompass`, the Windows installer, or a source checkout) and run `agentcompass setup`.
2. Build the plugin source:

   ```sh
   python -X utf8 scripts/build_plugin.py --output <new-absolute-directory>
   # a specific install or checkout, and a Cindy connection that differs from the router account:
   python -X utf8 scripts/build_plugin.py --output <dir> --router-cmd <agentcompass-executable|checkout|JSON command> --account-map map.json
   ```

   `map.json` is `[{"routerProvider":"codex","routerAccount":"codex","providerId":"<Cindy connection ID>","agentKind":"codex"}]`
   (`agentKind` is `cc`, `codex` or `pi`). The build installs nothing and refuses an existing output directory.
3. In Cindy: `ghost_forge_pack({dir:"<plugin source>"})`, install the `.cindy` through the official flow, approve Node, sessionContext and
   tasks, and set the plugin's task directory to the project being delegated.
4. Delegate: `ghost_call` with `{"ghost_id":"agentcompass","tool":"roll","args":{"task":"<complete task unchanged>"}}`, then call the
   `next_tool` it returns (`status`) until the run is terminal. There is no automatic callback.

Full setup, support boundary, the 2026-11-03 real acceptance on Cindy 0.1.121 and the cancel fix:
[docs/CINDY_REAL_ACCEPTANCE_AND_CANCEL_FIX.md](docs/CINDY_REAL_ACCEPTANCE_AND_CANCEL_FIX.md).

## Safety boundary

- Only Cindy's injected `session_context` identifies the parent; a caller-supplied one is replaced by the host. Remote or read-only
  workdirs and missing context are refused before anything is routed.
- The router is told `--local-only`, so it never starts a remote worker for a Cindy task. Router answers that are not a native route
  (`self`, `split`, …) come back unchanged and start nothing.
- No substitution: a model, connection, effort or permission Cindy cannot reproduce exactly is refused, never widened. A draft with the
  wrong route, permission or directory receives no input and is archived (or handed back for manual archiving).
- Idempotent and honest: one operation per session and task, stable request keys, unknown create/send is observed and never resent,
  `stopping` is not reported as stopped, cleanup never claims an archive that did not happen.
- No private IPC, no credentials, no model API of its own; full output stays on disk and only a bounded summary returns to the session.

## Tests

```sh
npm test                    # node: plugin boundary + real worker.cjs bridge; python: build script + hotfix refusals
npm run test:sandbox        # end-to-end in an isolated home: build -> fake Cindy host -> real worker.cjs -> real agentcompass roll
npm run test:sandbox:linux  # the same plus unit tests in the WSL docker-desktop distro, in a /run tmpfs with musl Node and Python
```

`test/sandbox-e2e.mjs` substitutes only the Cindy host (`test/zero_cindy_host.mjs`), the classifier's model (a local OpenAI-compatible
fixture) and a discovery placeholder for the provider CLI; the router's classifier client, allocator and ledger run for real. Set
`AGENTCOMPASS_CHECKOUT` to the AgentCompass checkout (default `../route_manager`). The latest Windows and Linux runs are in
[docs/sandbox-e2e-report.json](docs/sandbox-e2e-report.json), with every scenario's input and host record under `docs/sandbox-artifacts/`.
These are fixture-host results, not a real Cindy run.

## How AgentCompass fits with the other hosts

AgentCompass is the router: a System-One classifier profiles each task, the allocator picks an owner/model/effort against live quota, and
every decision is written to its ledger. Hosts own the sessions and the worker processes:

| Host | How work reaches AgentCompass | How the worker reports back |
|---|---|---|
| **Cindy** (this plugin) | the plugin's `roll` tool → `agentcompass roll --parent-host native` | the Cindy task's final message, collected with `status` |
| **Paseo** | `agentcompass roll` inside a Paseo agent (`PASEO_AGENT_ID`); AgentCompass launches the worker through Paseo | the worker messages its parent agent; AgentCompass notifies completion |
| **Herdr core** | `agentcompass roll` inside an `hc` terminal (`HC_TERMINAL_ID`); AgentCompass starts an owned child terminal | `hc send <parent>` from the worker |
| **Magpie** | [`magpie-agentcompass-router`](https://github.com/akiiwa-games/magpie-agentcompass-router): a Magpie gateway plugin that applies AgentCompass's task profiling and allocation to model requests | in the Magpie request path (routing, not task dispatch) |

Raw shell `roll` inside Cindy is refused by AgentCompass, because a Cindy shell exposes no addressable parent; use this plugin instead.

## License

MIT
