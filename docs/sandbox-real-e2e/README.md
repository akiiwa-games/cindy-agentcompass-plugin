# Real Cindy acceptance of the quick-text classifier

Status on 2026-11-07: **not accepted yet, blocked on a model sign-in in the guest.** Nothing here substitutes a fake host for it; the fake-host
suites (`npm run test:sandbox`, `npm run test:sandbox:linux`) are regression tests, not this acceptance.

## What was run on real Cindy

- `npm run test:sandbox:linux` runs `test/zero_cindy_host.mjs` in the WSL `docker-desktop` distro: a fake host, in a musl distro with a tiny
  root that cannot hold the glibc Electron build. So real Cindy runs in a disposable Windows Sandbox guest instead, as in
  [../real-cindy-0.1.121/](../real-cindy-0.1.121/acceptance.json).
- The official `cindy-0.1.121-win32-x64-global.exe`, SHA256 `6c8e485e4a200a5d41930dc74c3fbadcf23180bb1d886c3cda3b8a5ff056894b` (checked on the
  host and in the guest), signature valid (X.D. Network Inc.). `/S` alone crashes its NSIS helper in the guest (`0xc0000005` in `System.dll`);
  `/S /currentuser` installs it. Product version 0.1.121.
- Zero-configuration probe before start: no `agentcompass`, `python` or `node` on `PATH`, no `~/.agent-compass`.
- Cindy started with its own "skip login". The window reports `appVersion` 0.1.121 and "no model configured". It downloads 0.1.128 in the
  background (`getUpdateStatus`: `ready`) and `autoRelaunchOnIdle` is `false`, so the guest stays on 0.1.121 unless restarted.

## Why it stops there

`roll` reaches a plugin only through `ghost_call` from a Cindy agent, and an agent needs a model. The packaged build has no other way in: `devCall`
exists only in unpackaged builds (`ghosts:dev-runtime`, `src/main/cindy-brain/index.ts`). The classifier also needs a model on the quick-text
channel; a Codex (ChatGPT) sign-in serves both (`isOpenAiSubscriptionProvider` in `oneShotCandidates.ts`). A model is a credential of the user's,
which this run was not given.
