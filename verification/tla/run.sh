#!/bin/sh
set -eu

mode=${1:-safety}
case "$mode" in
  safety|progress|broken-fence) ;;
  *) echo "Usage: sh verification/tla/run.sh [safety|progress|broken-fence]" >&2; exit 2 ;;
esac

: "${TICKET_TLC_JAR:?Set TICKET_TLC_JAR to the absolute path of the pinned tla2tools.jar}"
case "$TICKET_TLC_JAR" in
  /*) ;;
  *) echo "TICKET_TLC_JAR must be an absolute path" >&2; exit 2 ;;
esac
expected=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
digest=$(shasum -a 256 "$TICKET_TLC_JAR")
if [ "${digest%% *}" != "$expected" ]; then
  echo "Unexpected TLC v1.7.4 release jar checksum" >&2
  exit 2
fi

source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ticket-tlc.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
cp "$source_dir/TicketRetention.tla" "$source_dir/$mode.cfg" "$scratch/"
cd "$scratch"

status=0
"${TICKET_JAVA:-java}" -XX:+UseParallelGC -Xmx768m -cp "$TICKET_TLC_JAR" tlc2.TLC \
  -workers 2 -config "$mode.cfg" TicketRetention.tla > tlc.log 2>&1 || status=$?
cat tlc.log

if [ "$mode" = broken-fence ]; then
  if [ "$status" -eq 0 ] || ! grep -Fq 'Invariant NoStaleWrite is violated.' tlc.log; then
    echo "Expected a NoStaleWrite counterexample" >&2
    exit 1
  fi
  echo "Observed the expected NoStaleWrite counterexample."
else
  exit "$status"
fi
