# Real-Cindy acceptance kit

Builds a disposable Windows Sandbox guest with real Cindy in it and drives it over CDP, so the plugin can be accepted on real Cindy.
Nothing here names a user, a host path or a machine id: every location is derived at run time from `<scratch>/run.json`.

| File | Where it runs | What it does |
| :-- | :-- | :-- |
| `prepare.mjs` | host | Makes `<temp>/cindy-real-xxxx/{stage,out}`, downloads the newest non-prerelease Windows `global` Cindy installer from the public release channel, checks signature and sha256 (it never runs it), stages `plugin/` and these scripts, writes `run.json` and `guest.wsb` |
| `make-sandbox-config.mjs` | host | Writes `guest.wsb` (`stage` read-only as `C:\stage`, `out` read-write as `C:\out`, networking on, no GPU, clipboard off) |
| `stage-credentials.mjs` | host | Copies the Codex and Claude sign-ins into `stage/signin` with every refresh token emptied; prints no value. `--remove` deletes them again (run it as soon as the guest has them) |
| `guest.mjs` | host | `wsb` wrapper: `start` (refuses if a sandbox already runs; connects and minimises the window without activating it), `setup <step>`, `exec`, `ip`, `window [show]`, `stop` |
| `guest-setup.ps1` | guest | Steps `probe` (zero-configuration), `install` (`/S /currentuser`), `signin` (moves the staged sign-ins into the guest profile), `launch` (Cindy with CDP, exposed on guest port 9223), `status`, `desktop` (screenshot of native dialogs), `sendkeys` |
| `cdp.mjs` | host | CDP driver for the guest's Cindy: `targets`, `eval`, `shot`, `text`, `click`, `type`, `mouse`; importable as a library |

Order of a run:

```sh
node test/real-cindy/prepare.mjs                       # prints <scratch>
node test/real-cindy/guest.mjs <scratch> start         # stops with exit 2 if a Windows Sandbox is already running
node test/real-cindy/guest.mjs <scratch> setup probe   # zero-configuration probe
node test/real-cindy/guest.mjs <scratch> setup install
node test/real-cindy/stage-credentials.mjs <scratch> && node test/real-cindy/guest.mjs <scratch> setup signin
node test/real-cindy/stage-credentials.mjs <scratch> --remove
node test/real-cindy/guest.mjs <scratch> setup launch && node test/real-cindy/guest.mjs <scratch> ip
node test/real-cindy/cdp.mjs <scratch> text            # then drive Cindy: skip login, install plugin/, ...
```

Notes measured on Cindy 0.1.135:

- `wsb start` is headless; `wsb exec --run-as ExistingLogin` needs a remote session, which `guest.mjs start` opens with `wsb connect`.
- The element `click()` of a Cindy button works for most controls; the account menu at the bottom of the sidebar needs `cdp.mjs mouse x,y`
  (CSS pixels; the screenshot is 1.5 times larger).
- The plugin page's Working folder opens a native folder dialog in the guest: type the path with `guest-setup.ps1 -Step sendkeys -Keys 'C:\work\proj{ENTER}'`, then `{ENTER}` twice more.
- Do not leave a copy of a sign-in anywhere: `<scratch>` is deleted at the end of a run, and nothing from `stage/signin` or the guest's profile belongs in a record.
