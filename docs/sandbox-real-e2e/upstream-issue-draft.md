# Draft issue for makecindy/cindy

Draft only, not posted. Publishing is the maintainer's call.

---

**Title:** A plugin that only declares `cindy.text` is blocked for signed-out users, by a card about images and video, while `setupStatus` says it is ready

## Environment

Cindy 0.1.121, Windows x64, global build (`cindy-0.1.121-win32-x64-global.exe`). Source references are at tag `v0.1.121`. On `main` at
2026-11-07, `ghostHostSetupRequirements.ts` and `readiness.ts` have the same logic.

## Reproduction, shared by the three points below

1. Install Cindy on a clean profile and choose to skip login. The sidebar shows 未登录.
2. Sign in to a model for agents, for example Codex with a ChatGPT subscription, and check that an agent answers.
3. Install a plugin whose manifest declares only a text capability and has a tool that uses no Cindy capability at all. Trimmed to what matters here;
   this demo was not run itself, the observations below are from the AgentCompass plugin, which declares the same capability:

   ```json
   {
     "id": "oneshot-gate-demo",
     "cindy": {"text": ["oneshot"]},
     "tools": [{"name": "ping", "description": "Answers pong", "inputSchema": {"type": "object"}}]
   }
   ```

4. In an agent session, call `ghost_call` with `{"ghost_id": "oneshot-gate-demo", "tool": "ping", "args": {}}`.

Observed: the session stops at a Setup card with the item "AI 模型服务" and the buttons 打开模型设置 and 取消. Cancelling answers
`{"ok":false,"errorCode":"SETUP_CANCELLED","message":"用户取消了插件设置，本次调用未执行。"}`. The plugin's logic page never runs.

We saw this with the AgentCompass plugin on the tools `roll` (with and without an explicit profile), `status`, `stop` and `cleanup`.

## 1. The card speaks of image or video capabilities; the plugin only uses text

The card says 使用插件声明的图片或视频能力前，需要先连接可用的模型服务. The plugin declares no image or video capability, so the user cannot tell
why it is being asked or what would satisfy it. "Open model settings" does not help either: a model signed in there does not satisfy the requirement.

- `apps/desktop/src/main/cindy-brain/ghostHostSetupRequirements.ts:27-31`: one description key for every manifest that has a `cindy` capability.
- `apps/desktop/src/main/cindy-brain/__tests__/ghostHostSetupRequirements.test.ts:63`: the zh-CN text.

**To reproduce:** the shared steps; read the card.

**Suggestion:** word the card after what the manifest declares, and say that a Cindy account is what is missing.

## 2. `ghosts.setupStatus` answers `ready: true` while `ghost_call` is stopped

With the card showing, in the DevTools console of the main window:

```js
await window.electronAPI.ghosts.setupStatus('oneshot-gate-demo')
// {ready: true, missingGroups: [], reauth: []}
```

The two read different assessments:

- `apps/desktop/src/main/cindy-brain/index.ts:5816-5823`: the `ghost_call` gate adds `assessGhostHostSetupRequirements(...)` as `additionalGroups`.
- `apps/desktop/src/main/cindy-brain/index.ts:9411` and `apps/desktop/src/main/cindy-brain/ghostSetupStatus.ts:336-341`: `ghosts:setup-status`
  evaluates the manifest without `additionalGroups`.

**To reproduce:** the shared steps, then the call above.

**Suggestion:** have `ghosts:setup-status` assess the same groups as the runtime gate, so that the plugin page and the gate agree.

## 3. Declaring only `cindy.text` requires the Cindy gateway, and other model sign-ins do not count

Any `cindy` capability needs `client_config:model-provider`, and that means the Cindy account:

- `apps/desktop/src/main/cindy-brain/ghostHostSetupRequirements.ts:30-31`: `ghostPermissionItems(manifest).some((item) => item.kind === 'cindy')`.
- `apps/desktop/src/main/model-access/readiness.ts:11-13`: `getAppCapabilities().canUseCindyGateway && Boolean(getProviderSecretStore().get('xd'))`.
- `apps/desktop/src/main/appCapabilities.ts:31`: `canUseCindyGateway` is `cloud`.
- `apps/desktop/src/main/mcp-integrations/ghost.ts:2171`: `ensureReady` runs for every tool of `ghost_call`, whether or not that tool uses the capability.

`oneshot_text` does not depend on the gateway, though. Its chain also runs on OpenAI subscription, xAI and Anthropic API-key connections, and it has
its own answer when nothing can serve it:

- `apps/desktop/src/main/utility-model/oneShotCandidates.ts:1014`: those providers go through `requestBuiltinProviderText`.
- `apps/desktop/src/main/utility-model/oneShotCandidates.ts:764-773`: `failedChainResult` reports `no_candidate`.
- `apps/desktop/src/main/cindy-brain/cindySlot.ts:1513-1526`: the slot itself only checks the manifest declaration.

So a user who has a working ChatGPT subscription in Cindy, and whose agents run on it, cannot use a plugin that wants one quick text answer. The whole
plugin stops, including tools such as `status` and `stop` that never reach the capability.

**To reproduce:** the shared steps. Step 2 shows the model working; step 4 shows the plugin refused.

**Suggestion:** do not apply `client_config:model-provider` to `text.oneshot` alone, for example by matching only the media capabilities in
`ghostHostSetupRequirements.ts`, and let `oneshot_text` answer `NO_CANDIDATE` when nothing can serve it, which plugins already handle.
