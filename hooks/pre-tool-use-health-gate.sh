#!/usr/bin/env bash
#
# PreToolUse health gate.
#
# The HTTP PreToolUse hook fails OPEN: if the bridge is down, the connection error is
# ignored and the tool runs without anyone approving it. That is unsafe for the gated
# tools. This script runs in parallel with the HTTP hook and DENIES gated tools when the
# bridge is unreachable. Claude Code applies the most restrictive result, so:
#   bridge up   -> this passes, the HTTP hook makes the real decision
#   bridge down -> this denies, the HTTP hook fails open -> final = deny
#
# Requires: curl, jq.

BRIDGE="${ZAPPER_URL:-http://127.0.0.1:8089}"

payload="$(cat)"
tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // ""')"

case "$tool_name" in
  Bash|Edit|Write|NotebookEdit) ;;       # only gated tools need the guard
  *) exit 0 ;;                            # everything else: let the HTTP hook decide
esac

auth=()
[ -n "${ZAPPER_TOKEN:-}" ] && auth=(-H "X-Observatory-Token: ${ZAPPER_TOKEN}")

code="$(curl --max-time 1 --silent --output /dev/null --write-out '%{http_code}' \
  "${auth[@]}" "${BRIDGE}/health" 2>/dev/null)"

[ "$code" = "200" ] && exit 0   # healthy -> defer to the HTTP hook

jq -n --arg s "$code" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("zapper bridge unhealthy (http " + $s + ") - blocked")
  }
}'
