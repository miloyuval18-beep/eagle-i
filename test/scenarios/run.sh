#!/bin/sh
# Runs every scenario against the local DATABASE_URL (see _local.js).
cd "$(dirname "$0")"
fail=0
for f in *.js; do
  case "$f" in _*) continue;; esac
  out=$(node "$f" 2>&1 | grep -E "PASSED|FAILED" | head -1)
  echo "$f: ${out:-no result}"
  echo "$out" | grep -q PASSED || fail=1
done
exit $fail
