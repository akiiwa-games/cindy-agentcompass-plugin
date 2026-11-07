# Real Cindy acceptance of the quick-text classifier

Status on 2026-11-07: **classification is not accepted on real Cindy.** Every plugin tool stops at Cindy's Setup gate unless Cindy is signed in to a
Cindy account, and this run has no such account. The fake-host suites (`npm run test:sandbox`, `npm run test:sandbox:linux`) are regression tests,
not this acceptance.

## Conclusion so far: the Setup gate

**A user who is not signed in to a Cindy account is stopped on every tool of this plugin.** Evidence: [setup-gate.json](setup-gate.json),
[setup-card.png](setup-card.png).

| Call from a real agent (Pi on `chatgpt/gpt-6.1-sol`, signed out of Cindy) | Result |
| --- | --- |
| `roll` with a task | Setup card, then `SETUP_CANCELLED` |
| `roll` with a task and a complete `profile` | Setup card, then `SETUP_CANCELLED` |
| `stop`, `cleanup`, `status` | Setup card, then `SETUP_CANCELLED` |

`~/.agent-compass/cindy-plugin` did not exist afterwards: the plugin never ran. So the three planned sign-in configurations (Codex only; Codex + Claude +
Grok; Claude only) do not reach classification. In particular, a Claude-only user gets the card, not `NO_CANDIDATE`, and a complete `profile` does not help.

Cindy's side does not line up in two places:

- the card speaks of image or video capabilities (使用插件声明的图片或视频能力前…), while the plugin declares only `cindy.text: ["oneshot"]`;
- `ghosts.setupStatus` answers `{ready: true, missingGroups: [], reauth: []}` while `ghost_call` is stopped.

[upstream-issue-draft.md](upstream-issue-draft.md) has both, with the requirement itself, source positions and reproduction steps. It is a draft and has
not been posted.

## A placeholder `xd` does not pass the gate

The gate needs `canUseCindyGateway` **and** a stored `xd` secret. A placeholder stored with `safeStorageStore('api_key', ...)` in the guest was accepted by
the store, and `roll` still stopped at the same card: `canUseCindyGateway` is true only in cloud mode, which Cindy commits after auth verifies a real
membership. The placeholder was removed again, so no result in this directory comes from it.

The packaged build also has `NodeCliInspect` off, `EmbeddedAsarIntegrity` and `OnlyLoadFromAsar` on. Getting further without a real sign-in means re-signing
Cindy or faking its account service. That was not done.

## What was run

- `npm run test:sandbox:linux` runs `test/zero_cindy_host.mjs` in the WSL `docker-desktop` distro: a fake host, in a musl distro with a tiny root that
  cannot hold the glibc Electron build. So real Cindy runs in a disposable Windows Sandbox guest instead, as in
  [../real-cindy-0.1.121/](../real-cindy-0.1.121/acceptance.json).
- The official `cindy-0.1.121-win32-x64-global.exe`, SHA256 `6c8e485e4a200a5d41930dc74c3fbadcf23180bb1d886c3cda3b8a5ff056894b` (checked on the host and
  in the guest), signature valid (X.D. Network Inc.). `/S` alone crashes its NSIS helper in the guest (`0xc0000005` in `System.dll`); `/S /currentuser`
  installs it ([install.json](install.json)).
- Zero-configuration probe before start: no `agentcompass`, `python` or `node` on `PATH`, no `~/.agent-compass` ([zero-config-probe.json](zero-config-probe.json)).
- Cindy started with its own "skip login". It downloads 0.1.128 in the background (`getUpdateStatus`: `ready`) and `autoRelaunchOnIdle` is `false`; a forced
  restart stays on 0.1.121.
- Credentials: a copy of the Codex login, `refresh_token` emptied so that the host's login cannot be rotated away. Cindy accepted it. It stayed in the guest.
- Install: `ghost_forge_pack` and `ghost_forge_install` from a real agent. The consent dialog lists the quick-text channel ([install-consent.png](install-consent.png)).

## Other findings on real 0.1.121

- **The Codex harness fails on every chat** with an OpenAI subscription: `turn/start error -32600: This chat uses cindy_openai, but your current provider is
  cindy_gateway`. Cindy issues #8926 and #8392, fixed in 0.1.122 and later (PR #8171). The missing refresh token is not the cause. The Pi harness on the same
  login works, so this run drives agents on Pi. A plugin route onto the `codex` harness will fail the same way on 0.1.121.
- Cindy keeps its xAI sign-in in its own encrypted store and does not read `~/.grok/auth.json`, so a copied Grok login does not reach it.
