#!/usr/bin/env bash
# Cold-start rehearsal of .github/workflows/browser.yml in a fresh Ubuntu 24.04
# container: no .env files, no node_modules, no browser cache, CI=true.
# The checkout is a copy of tracked and unignored files (git ls-files), so env
# files and local evidence never enter the container.
#
#   scripts/browser-linux-rehearsal.sh [docker context] [extra test:browser args...]
#
# Exit status is the container's (the browser suite's). Evidence is copied to
# test-results/linux-rehearsal/ on the host.
set -euo pipefail
context="${1:-${DOCKER_CONTEXT:-default}}"; shift || true
root="$(git rev-parse --show-toplevel)"
out="$root/test-results/linux-rehearsal"
rm -rf "$out"; mkdir -p "$out"
args="$(printf '%q ' "$@")"
cid="$(docker --context "$context" create --shm-size=1g -e REHEARSAL_ARGS="$args" -e GITHUB_SHA="$(git rev-parse HEAD)" -e CI=true -e BROWSER_TRACE=off -e MEDIA_CLEANUP_ENABLED=false -e UPLOADTHING_TOKEN= \
  -w /work ubuntu:24.04 bash -lc '
set -euo pipefail
stage() { echo "::stage $1 $(date -u +%H:%M:%S)"; }
stage system-packages
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils git >/dev/null
stage node
arch=$(uname -m); case "$arch" in x86_64) arch=x64;; aarch64) arch=arm64;; esac
version=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o "\"version\":\"v24[^\"]*\"" | head -1 | cut -d\" -f4)
curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-$arch.tar.xz" | tar -xJ -C /opt
export PATH="/opt/node-$version-linux-$arch/bin:$PATH"
node --version
stage pnpm
corepack enable && corepack install >/dev/null && pnpm --version
git init -q && git add -A >/dev/null && git -c user.email=ci@local -c user.name=ci commit -qm rehearsal
stage install
pnpm install --frozen-lockfile
stage chromium
pnpm exec playwright install --with-deps chromium >/dev/null
stage browser
status=0; eval "pnpm test:browser $REHEARSAL_ARGS" || status=$?
stage evidence
pnpm browser:evidence summary || true
pnpm browser:evidence verify || status=$((status ? status : 9))
pnpm test:visual --repeat 3 --out test-results/visual || echo "visual pilot exit $?"
exit $status
')"
trap 'docker --context "$context" rm -f "$cid" >/dev/null 2>&1 || true' EXIT
# BSD and GNU tar spell the path prefix differently.
if tar --version 2>/dev/null | grep -q GNU; then prefix=(--transform 's,^,work/,'); else prefix=(-s ',^,work/,' --no-xattrs --no-mac-metadata); export COPYFILE_DISABLE=1; fi
(cd "$root" && git ls-files -co --exclude-standard -z | tar --null -T - "${prefix[@]}" -cf -) | docker --context "$context" cp - "$cid:/"
status=0
docker --context "$context" start -a "$cid" || status=$?
docker --context "$context" cp "$cid:/work/test-results/." "$out/" 2>/dev/null || true
echo "Linux rehearsal exit $status; evidence in $out"
exit $status
