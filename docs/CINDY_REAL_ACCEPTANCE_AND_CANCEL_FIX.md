# Cindy: setup, support boundary, real acceptance and the 0.1.121 cancel fix

This document carries over the Cindy material that used to live in AgentCompass (`skills/agent-compass/references/herdr-cindy.md`,
`.route-briefs/cindy-real-acceptance/REPORT.md`, `.route-briefs/cindy-cancel-fix/`). The plugin now lives only in this repository.
What changed in the move comes first; the rest describes the plugin as it is now.

## What changed when the plugin left AgentCompass

- AgentCompass no longer has a `cindy` host, a `cindy build-plugin` command, `ROUTER_CINDY_CONTEXT` or a Cindy-specific prompt branch.
  The plugin uses only the public router: `agentcompass roll --parent-host native --parent-id <session_id> --parent-address <session_id>
  --local-only "<reason>" --task - --verbose`, with the host-verified Cindy `session_id` as the parent.
- `--local-only` states the real constraint (the worker runs as a Cindy task in the parent's local project directory), so the router never
  starts a remote worker such as Dot or the Grok bot on the plugin's behalf. Before the move the core refused such routes after
  allocation; now they are not candidates.
- What `host_cindy.prepare` used to do moved into `plugin/worker.cjs`: it accepts only the `claude`, `codex` and `pi` harnesses, makes the
  launcher permission explicit when the fleet bundle omits `modeId` (Claude `bypassPermissions`, Codex `full-access`, Pi's fixed
  full-tool worker as `full-access`), refuses an explicitly different mode instead of widening it, and appends the Cindy return-channel
  contract to the router's worker prompt.
- A router answer that is not a native route (`self`, `split` or anything else) is returned to the Cindy session unchanged and starts no
  Cindy task.
- `scripts/build_plugin.py` replaces `agentcompass cindy build-plugin`; `--router-cmd` binds an explicit AgentCompass install.
- AgentCompass keeps one Cindy-aware guard: raw shell `roll` inside a Cindy shell (its `CINDY_*` markers, no `--parent-host`) is refused,
  so a provider thread or the askpass route is never used as a Paseo parent. The sandbox run checks it.

## First-time setup

The stock shell is insufficient: `CINDY_INPUT_HANDOFF_ROUTE` is an opaque askpass capability, not a session ID, and Pi deliberately strips
`CINDY_PI_SESSION_ID` from bash children. Use the installable plugin, whose declared `sessionContext:true` gets the actual parent and local
workdir from Cindy. Cindy strips caller-supplied `session_context` before injecting its own value. The plugin's packaged Node worker invokes
the public `agentcompass roll`; callers supply only the task. The bridge has no private IPC, credentials or model API of its own.

1. Install AgentCompass normally, then build a fresh plugin source directory:

   ```sh
   python -X utf8 scripts/build_plugin.py --output <new-absolute-directory> [--router-cmd <json-or-path>] [--account-map <file>]
   ```

   `--router-cmd` is a JSON array that is the whole roll command (`["/path/to/agentcompass","roll"]`), an `agentcompass` executable, or an
   AgentCompass checkout (run with the Python that runs the build). Without it the `agentcompass` on PATH is bound. Rebuild after moving or
   removing that install; the plugin does not ship an embedded router.

2. If Cindy uses a different connection ID for a router account, pass an explicit map with `--account-map <file>`:

   ```json
   [{"routerProvider":"codex","routerAccount":"codex","providerId":"<exact Cindy connection ID>","agentKind":"codex"}]
   ```

   `agentKind` is `cc`, `codex` or `pi`. The mapping is a connection binding, not permission to change the routed account. Without a map
   only identical account/provider IDs match. Inspect Cindy's actual catalog; do not guess aliases or silently choose a default connection.

3. In Cindy use its official `ghost_forge_pack({dir:"<plugin source>"})`, then install the resulting `.cindy` through the official
   installation flow. Approve Node, sessionContext and tasks capabilities. In Cindy's plugin task settings, set the work directory to the
   project being delegated and allow the required permission level. These are setup steps, not per-task arguments.

4. Delegate through the plugin's `roll` tool with Cindy's public `ghost_call`:

   ```json
   {"ghost_id":"agentcompass","tool":"roll","args":{"task":"<complete task unchanged>"}}
   ```

   The host supplies the context. Unsupported, remote or read-only contexts fail before dispatch.

## Support boundary and completion

The plugin declares `minCindyVersion: "0.1.121"`. Official Windows **Cindy 0.1.121** was installed and exercised in a real Windows Sandbox
on **2026-11-03** with an authenticated Codex account (record below). Its runtime reports the tasks API as experimental. Installation, exact
Codex routing, task execution, result collection and manual UI archiving were verified; **cancellation acceptance failed**, so this is not
full lifecycle acceptance. Claude and Pi authenticated flows were not tested. That real run used the plugin as it was inside AgentCompass
(`--parent-host cindy`); the standalone plugin's native-parent path is so far verified only by the sandbox run against the real router and
a fake Cindy host (`docs/sandbox-e2e-report.json`).

The plugin requires the runtime capabilities `models/create/send/get/getRun/listRuns/readMessages/cancel`, `exactRoute:true` and
`createPermissionMode:true`. `archive` is optional: 0.1.121 does not expose it. Older hosts without the core capabilities are unsupported;
there is no invented native fallback.

On a compatible build the plugin checks exact harness, connection, model, effort and fast support against `tasks.models()`, maps the
supported modes to Cindy's documented `bypassPermissions`, and after create checks `resolvedConfig`, permission, plan state and the exact
project directory before sending input with the task's `expectedRevision`. A rejected draft is archived through the public API when
available; otherwise its confirmed ID and manual cleanup instructions are returned. Creating a draft never means launched. Task plus the
appended return contract must fit Cindy's 32,768-character send limit; oversized tasks are rejected without truncation.

Each assignment has stable create/send request keys and a durable operation receipt (`~/.agent-compass/cindy-plugin/<operation>/`).
Concurrent calls are serialized. Unknown delivery is observed without resending; a confirmed run is found only within the uniquely created
plugin-owned task. For `unknown_create` the public task list does not expose the create request key, so the possible orphan draft cannot
be identified safely: inspect the plugin's tasks in Cindy and archive the confirmed idle draft there; do not resubmit or claim cleanup.

There is **no automatic completion callback**. `roll` returns an exact `next_tool` call to `status`. Status reads `getRun`, paginates
`readMessages` (up to ten pages per call), saves every page on disk and selects the exact `outputMessageId` for this run. Workers return
questions as `BLOCKED / needs_input` and their final report as a final assistant reply; the parent collects them through status. The parent
session ID is genuine context, not a generally addressable mailbox.

`stop` calls scoped `tasks.cancel`. `stopping` or `reconciling` does not prove the process has stopped (see the failed cancellation
criterion below). `cleanup` refuses active runs; with archive it archives the confirmed inactive plugin-owned task and keeps history,
without archive it returns `manual_cleanup_required`, `archived:false` and the exact task ID.

Primary sources: [Cindy session context](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-session-context.md),
[Node protocol](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-node-worker.md),
[ordinary tasks API](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/docs/dev-rules/plugin-task-api-implementation.md),
[task slot capabilities and validation](https://github.com/makecindy/cindy/blob/85428ac8085427e9de062341ba394c9562b20f86/apps/desktop/src/main/cindy-brain/taskSlot.ts).

## The 0.1.121 cancel fix

`patches/cindy-0.1.121-cancel.patch` is the upstream source fix for the failed criterion: plugin cancel interrupts the owned session
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
official release: the vendor signature is no longer valid after patching. `test/test_cancel_hotfix.py` covers the refusals only; a
repeated real cancellation acceptance with the patched build is not recorded here.

### Hotfix contract (original)

### 本地 Cindy 补丁合同

失败：真实 cancel 调用 graceful stop，正在执行的命令仍写出结束标记；任意版本替换压缩代码可能破坏程序。
动作：仅限制已关闭 Cindy 安装中的 app.asar 修改，不影响诊断、测试或官方安装。
判定：package 版本、实际目标 member 内容与已审阅官方 0.1.121 编译代码一致；哈希仅证明内容一致，不宣称运行正确。保留完整原始 archive，修改 member 与其完整性信息，其余 payload 不变。
恢复：对匹配版本使用 apply；不匹配版本从对应源码构建；restore 从验证过的原始备份恢复，不覆盖更新后的其他版本。
降级：读写、解析或版本不匹配均不替换目标。已有备份不同就保留备份并报错。此限制不引入额外用户确认。
验证：真实安装包 check/apply/restore 字节一致性、修改包成功启动、真实取消后禁止文件缺失，三者分开记录。源码回归验证立即中断、代次替换和撤权不误停、错误不假装成功。

## Real acceptance record, 2026-11-03 (original)

Evidence paths in this record refer to the acceptance working directory kept on the test machine (formerly
`route_manager/.route-briefs/cindy-real-acceptance/`); they are not part of this repository. Commands named there
(`cindy build-plugin`, `test_cindy`, `zero_dispatch_check.py --only ... cindy`) are the pre-split AgentCompass forms.

### Cindy 真实沙盒验收记录

日期：2026-11-03，时区 UTC+08。结论：**未通过完整验收**。安装、真实账号接入、插件安装、真实任务派发和结果回收通过；取消运行未能阻止后续命令副作用。不能将模拟测试通过表述为真实生命周期验收通过。

#### 环境与范围

- Windows Sandbox，独立用户 WDAGUtilityAccount；本机凭据按用户授权临时移入，不在报告或工具输出中记录凭据值。
- 官方 Windows Cindy **0.1.121**，安装器签名验证为 Valid / X.D. Network Inc.；[官方发行页](https://github.com/makecindy/cindy/releases/tag/v0.1.121)。安装器 SHA256：`6c8e485e4a200a5d41930dc74c3fbadcf23180bb1d886c3cda3b8a5ff056894b`。
- AgentCompass 工作树构建 wheel **0.3.4**，沙盒新建虚拟环境安装，执行 `agentcompass setup --yes`；Cindy 自带 Codex CLI **0.159.2**。
- Cindy 使用其“跳过登录”和“使用本机 Codex 账号”流程，成功载入真实模型与额度。未验收 Cindy 云账号登录，也未验收 Claude / Pi。
- 真实 router 选择 `sol_medium`，实际执行配置 `codex / openai / gpt-6.1-sol / medium`；插件显式映射 router 账号 `codex/codex` 到 Cindy connection `openai`。
- 原始工作树并不能直接安装使用。本次发现并修复两个兼容性问题后，才用 R3 构建完成后续验收；修改尚未提交或发布。

#### 验收结果

| 环节 | 结果 | 实际证据 |
|---|---|---|
| 官方 Cindy 全新安装、启动 | 通过 | `guest-out/install.log`、`installed.json`、`launched.json` |
| AgentCompass wheel 安装、setup、build-plugin | 通过 | 安装和 R3 重装日志、`guest-out/tested-plugin/` |
| 真实 Codex 凭据接入 | 通过 | 真实模型调用和成功文件，不依赖假账号或 mock API |
| 官方插件 pack/install/update | 修复后通过 | `tool-exchanges.json` 中真实 `ghost_forge_install` 返回；首次 manifest 失败也保留 |
| 插件权限和工作目录 | 通过 | `configured.json/png`；官方 UI 配置完全访问及当前会话目录 |
| 通过真实 `ghost_call` 派发 | 修复后通过 | host 注入 session_context，真实 router 选择，真实任务和 run ID |
| 执行、落盘、回收准确结果 | 通过 | `acceptance-result.txt` 精确为 24 字节 `CINDY_REAL_ACCEPTANCE_OK`；对应 outputMessageId 和完整分页产物 |
| 取消正在执行的任务 | **失败** | stop 返回 stopping，睡眠命令继续执行，并写出了取消后不应出现的文件 |
| 自动归档 | 当前版本不支持 | capabilities 缺少 archive；插件明确返回 manual_cleanup_required / archived:false |
| 人工归档与收尾 | 通过 | 两任务经 Cindy 菜单归档，公开 API 复查 archived；沙盒已关闭 |

#### 两个已修复的问题

1. schemaVersion 3 的 manifest 缺少 `minCindyVersion`，真实官方安装器返回 `MANIFEST_INVALID`。补上 `0.1.121`，并增加构建产物的版本字段断言。
2. 原插件把 `archive` 当作所有派发的前提，但真实 0.1.121 没有该能力。保留模型、创建、发送、读状态/结果、取消及精确路由/权限要求，将归档能力独立判断。没有 archive 时允许派发，cleanup 如实返回待手动处理的已确认 taskId；活动任务仍拒绝 cleanup。错误目录/模型/权限的草稿也明确报告手动归档，不发送任务输入。

修改涉及 README、Cindy manifest/main.js、支持说明、Node/Python 测试及 fake-host 验收脚本。完整本次差异保存在 `artifacts/source.patch`。已核对实际沙盒安装的 ghost.json / main.js 与当前工作树逐字节一致。归档能力要求调整的合同和测试依据见 `gate-contract.md`。

#### 真实任务定位

父会话：`066f8624-4d17-4163-8e34-e1f9bc13441d`。

| 字段 | 成功任务 | 取消测试任务 |
|---|---|---|
| operation | `e5e5c0054e8e38e2534846013a4660e9314dec3e` | `b3a1542b1adbd34404ae4c015adb29ff27b81ce0` |
| taskId | `688bbe2d-2f61-4891-8536-a0e216f9feb8` | `3d79165e-c944-4f9f-ae7c-faf797ea73c1` |
| runId | `3776e07a-a6a8-4f1f-97d4-decf4d10271b` | `db8ae702-3b87-44aa-8b00-cac25cc857ee` |
| outputMessageId | `t58jms2ucvfsw1qh8h3qh1oa` | `ydk7wjq3kz10ke5xd8z24zfc` |

成功文件 SHA256：`c783d735b8cefd1dc9c51c1281835f28a419b530dc434c4a21db98ed3910f246`。

#### 取消失败复现与判定

1. 真实子任务先写 `cancel-started.txt = CINDY_CANCEL_STARTED`，执行前台等待 120 秒的命令，正常完成后写 `cancel-should-not-exist.txt = CINDY_CANCEL_COMPLETED`。
2. run acceptedAt 为 **13:14:00.645 +08**。确认开始标记后，在 **13:14:50.371 +08** 发起真实插件 stop 调用，底层 scoped cancel 返回 `stopping`。
3. 后续 status 仍报告 stopping。最终宿主在 **13:16:09.008 +08** 报 completed，且禁止出现的结束文件真实存在，22 字节，内容完全符合正常完成标记。
4. 该文件 SHA256 为 `b6703b59c0006d0aceb58089183d4b7ca3d3abd79442bf84af8efda9e5311f9b`。回收的消息却为“前台命令仍在等待，尚未返回。”，因此也不能仅凭 completed 和消息摘要推断取消生效。

这证明本次真实路径中“取消阻止后续副作用”的验收条件失败。尚未将根因定位到 Cindy、Codex CLI 或具体进程管理层；本次没有伪造 cancelled、改成强杀任意进程，或宣称已修复取消问题。剩余阻塞项是定位并修复真实取消传播，再重复该标记验收。

#### 指令操作方式

大部分步骤已经通过命令执行：Windows Sandbox CLI、官方静默安装器、pip、setup、build-plugin，以及 Cindy 模型公开工具 `ghost_forge_install` / `ghost_call`。使用插件的 roll/status/stop/cleanup 是当前支持的真实任务入口，例如：

```json
{"ghost_id":"agentcompass","tool":"roll","args":{"task":"完整任务原文"}}
```

该参数需提交给 Cindy 的 `ghost_call`，由 Cindy 注入真实 session_context。普通外部 shell 不具备这个上下文，不能靠猜父会话 ID 替代。首次工作目录授权使用原生目录选择器，缺少公开 archive API 时使用 Cindy 的归档菜单。未使用私有 IPC 绕过这些接口。CDP 用于界面操作、截图和公开 scoped API 的只读核对。

#### 回归与证据索引

- Python `python -X utf8 -m unittest test_cindy`：**8/8**，日志 `artifacts/python-tests.log`。
- Node `node --test skills/agent-compass/scripts/test_cindy_plugin.mjs`：**8/8**，日志 `artifacts/node-tests.log`。涵盖缺少核心 cancel 拒绝派发、可选 archive、错误草稿无输入、活动 cleanup 拒绝和终态手动 cleanup 可重复。
- 模拟外部边界：`packaging/zero_dispatch_check.py --only isolation install setup accounts_and_usage cindy`，**0 failures**，Cindy 11 场景、53 断言。完整报告 `regression/run-20261103-131626/report.md`。
- 首次选取回归场景时遗漏 accounts_and_usage 中的假 scorer 初始化，造成 32 条失败；保留 `regression/run-20261103-131423/report.md`。补齐运行前置场景后通过。这些均是模拟边界测试，不能覆盖上面的真实取消失败。
- 本次涉及的 8 个源文件 `git diff --check` 通过；未修改工作树中其他已有的 tray 改动。
- `guest-out/tool-exchanges.json`：17 条实际工具调用与返回，包括安装失败、更新、roll/status/stop/cleanup。
- `guest-out/actual-capabilities-action.json`：真实宿主 capabilities/catalog。
- `guest-out/files-verified.json`：三个标记文件内容、长度、SHA256；原文件也保留在 guest-out。
- `guest-out/receipts/`：完整插件操作收据、分页结果等原始产物。
- `guest-out/completed-result.*`、`cancellation-final.*`、`cancellation-api-action.json`：执行及取消证据。
- `guest-out/archived-verified-action.json`：两个任务公开 API 返回 archived。
- `artifacts/agentcompass-0.3.4-py3-none-any.whl`：实际 R3 测试 wheel；SHA256 `48c8e7c767a48e1b3d1c64ae37b64bb9328ad74fb16fa3b41cf9fc3295ad88c4`。
- `guest-out/tested-plugin/`：实际安装的源码与 .cindy 包；其 router.json 绑定已销毁沙盒的路径，不能直接当本机可用安装包，需在目标环境重新 build-plugin。
- `state.json`：安装器、wheel、插件文件哈希及清理结果。

#### 清理记录

两个任务已归档；前台 120 秒测试命令自然结束后，`guest-out/cancel-processes.json` 确认没有匹配的遗留测试命令。保存产物后关闭本次唯一沙盒 `42d45469-424e-453d-9c04-10238b0251c8`，`wsb list --raw` 返回 `WindowsSandboxEnvironments: []`。连接辅助进程 PID 69664 已结束。临时 staging 目录已删除，凭据 staging 副本此前已删除，沙盒中的凭据随虚拟机销毁；没有复制凭据到验收产物。无本次长任务遗留。
