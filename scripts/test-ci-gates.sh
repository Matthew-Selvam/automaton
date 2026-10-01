#!/usr/bin/env bash
# CI Gate Logic Tests
#
# The workflow logic this covers cannot be exercised by vitest, and it is the
# entire subject of the "CI gates" change: a bash suite that fails green is
# worse than no gate. These assertions run the same handler shape locally.
#
# Run: bash scripts/test-ci-gates.sh

set -uo pipefail

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# ── The handler under test ──────────────────────────────────────────
# Mirrors .github/workflows/ci.yml. `run_test_suite <label> <command...>` runs the
# command, and applies the 124 policy.
handle() {
  local rc=$1
  if [ "$rc" -eq 124 ]; then
    echo "::warning::hit budget, re-running"
    return 1   # step fails unless the re-run exits 0
  fi
  return "$rc"
}

echo "timeout-124 policy"
handle 0 >/dev/null; check "clean run passes"            "$?" "0"
handle 1 >/dev/null; check "test failure fails"          "$?" "1"
handle 124 >/dev/null; check "timeout does NOT pass"     "$?" "1"

echo
echo "PIPESTATUS propagation through tee"
# This is the trap the workflow has to avoid: after `cmd | tee log`, bash sets
# $? to tee's status, so a FAILING suite would look successful.
( set +e; false 2>&1 | tee /dev/null >/dev/null; echo "${PIPESTATUS[0]}" ) > /tmp/ps1.out
check "PIPESTATUS[0] reports the real failure" "$(cat /tmp/ps1.out)" "1"
( set +e; true 2>&1 | tee /dev/null >/dev/null; echo "${PIPESTATUS[0]}" ) > /tmp/ps2.out
check "PIPESTATUS[0] reports success" "$(cat /tmp/ps2.out)" "0"
# Demonstrates WHY \$? alone is unsafe here: after a pipe it reports tee's
# status (0), not the test command's. This is exactly the bug the original CI
# step had, where `RC=$?` after a pipe would report success for a failing suite.
cat > /tmp/dollarq_probe.sh <<'PROBE'
false 2>&1 | tee /dev/null >/dev/null
echo $?
PROBE
DOLLAR_Q=$(bash /tmp/dollarq_probe.sh)
check "\$? alone reports tee (0), masking failure" "$DOLLAR_Q" "0"
rm -f /tmp/dollarq_probe.sh

echo
echo "test:security filter actually selects tests"
SEC_COUNT=$(npx vitest run --testNamePattern "security|injection|policy|financial" 2>&1 \
  | grep -oE "Tests +[0-9]+ passed" | head -1 | grep -oE "[0-9]+")
if [ -n "${SEC_COUNT:-}" ] && [ "$SEC_COUNT" -gt 0 ]; then
  ok "filter selects $SEC_COUNT tests (was CACError before the fix)"
else
  bad "filter selected no tests"
fi

# The old flag must be a hard error, not a silent no-op.
if npx vitest run --grep ZZZNOMATCH >/dev/null 2>&1; then
  bad "--grep was accepted (expected it to be rejected)"
else
  ok "--grep is rejected, so the old script could never have filtered"
fi

echo
echo "totals: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
