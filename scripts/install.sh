#!/usr/bin/env bash
#
# Merge Zapper Open's hooks into ~/.claude/settings.json.
# Backs up the existing file, substitutes the repo path, and unions the hook arrays.
# Idempotent-ish: re-running appends again, so review the result or restore the backup.
#
# Requires: jq.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
SNIPPET="$REPO/settings-snippet.json"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

backup="$SETTINGS.before-zapper.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$backup"
echo "backup: $backup"

# fill in the absolute repo path, drop the comment field
add="$(sed "s#__REPO__#$REPO#g" "$SNIPPET" | jq 'del(._comment) | .hooks')"

# union each hook event's array (existing first, then ours)
jq --argjson add "$add" '
  .hooks = ((.hooks // {}) as $h
    | reduce ($add | keys[]) as $k ($h; .[$k] = (($h[$k] // []) + $add[$k])))
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "merged hooks into $SETTINGS"
echo "restart Claude Code so it reloads settings.json."
