#!/bin/sh
# Linux sandbox run: unit tests and test/sandbox-e2e.mjs in a throwaway tmpfs directory with musl Node and Python.
#
# Written for the WSL `docker-desktop` distro (musl, a ~50 MB root, Windows drives under /mnt/host), from Windows:
#   wsl -d docker-desktop -- sh /mnt/host/<drive>/<path>/cindy-agentcompass-plugin/test/run-linux-sandbox.sh
#
#   CINDY_SANDBOX_CACHE       directory holding the two runtime archives below (downloaded with wget when missing)
#   AGENTCOMPASS_CHECKOUT_SRC AgentCompass source checkout (default: ../route_manager next to this repository; scripts/run-linux-sandbox.mjs also finds it from a git worktree)
#   CINDY_SANDBOX             tmpfs work directory, removed on exit (default: /run/cindy-sandbox)
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
CACHE=${CINDY_SANDBOX_CACHE:-$REPO/../.cindy-sandbox-cache}
CHECKOUT_SRC=${AGENTCOMPASS_CHECKOUT_SRC:-$REPO/../route_manager}
SANDBOX=${CINDY_SANDBOX:-/run/cindy-sandbox}
NODE_TGZ=node-v24.22.2-linux-x64-musl.tar.gz
NODE_SHA=867e322d67294e9c405f10cae5d70ed2e4940bb367fa47dbcb5151c9899d7c04
NODE_URL=https://unofficial-builds.nodejs.org/download/release/v24.22.2/$NODE_TGZ
PY_TGZ=cpython-3.12-musl.tar.gz
PY_SHA=4d9432edbbf38a9d61711ba5ad6d870de3d5899d93eaf686e9cbeb5b0686de90
PY_URL=https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-x86_64-unknown-linux-musl-install_only.tar.gz

cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

fetch() {  # archive, sha256, url
  if [ ! -f "$CACHE/$1" ]; then mkdir -p "$CACHE"; wget -q -O "$CACHE/$1" "$3"; fi
  echo "$2  $CACHE/$1" | sha256sum -c -
}
fetch "$NODE_TGZ" "$NODE_SHA" "$NODE_URL"
fetch "$PY_TGZ" "$PY_SHA" "$PY_URL"

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/runtime/node" "$SANDBOX/tmp" "$SANDBOX/AgentCompass" "$SANDBOX/plugin-repo"
tar -xzf "$CACHE/$NODE_TGZ" -C "$SANDBOX/runtime/node" --strip-components=1
tar -xzf "$CACHE/$PY_TGZ" -C "$SANDBOX/runtime"
cp -r "$CHECKOUT_SRC/agentcompass" "$CHECKOUT_SRC/skills" "$CHECKOUT_SRC/pyproject.toml" "$SANDBOX/AgentCompass/"
find "$SANDBOX/AgentCompass" -name __pycache__ -type d -prune -exec rm -rf {} +
for part in package.json README.md plugin scripts test docs; do cp -r "$REPO/$part" "$SANDBOX/plugin-repo/"; done

NODE=$SANDBOX/runtime/node/bin/node
PY=$SANDBOX/runtime/python/bin/python3
export PATH="$SANDBOX/runtime/node/bin:$SANDBOX/runtime/python/bin:/usr/bin:/bin"
export HOME="$SANDBOX/tmp/home" TMPDIR="$SANDBOX/tmp" PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1
mkdir -p "$HOME"

echo "=== Linux sandbox"
uname -a
head -n 1 /etc/os-release
echo "node $("$NODE" --version), $("$PY" --version), AgentCompass $("$PY" -X utf8 "$SANDBOX/AgentCompass/agentcompass" --version)"

echo "=== Sandbox end-to-end (includes the unit tests)"
cd "$SANDBOX/plugin-repo"
status=0
CINDY_SANDBOX_ROOT="$SANDBOX/e2e" AGENTCOMPASS_CHECKOUT="$SANDBOX/AgentCompass" AGENTCOMPASS_PYTHON="$PY" \
CINDY_SANDBOX_LABEL=linux CINDY_SANDBOX_REPORT="$SANDBOX/linux-report.json" \
CINDY_REPORT_MERGE_INTO="$REPO/docs/sandbox-e2e-report.json" "$NODE" test/sandbox-e2e.mjs || status=$?
mkdir -p "$REPO/docs/sandbox-artifacts/linux"
cp "$SANDBOX/e2e/report/cindy/"*.json "$REPO/docs/sandbox-artifacts/linux/" 2>/dev/null || true
exit $status
