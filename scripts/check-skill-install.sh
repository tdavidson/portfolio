#!/usr/bin/env bash
# Install the repo's agent skills the way a fund would (`npx skills add tdavidson/portfolio`) and
# check every skill and its reference files landed.
#
#   scripts/check-skill-install.sh [SOURCE]     # SOURCE: a path (default: this checkout) or owner/repo
#
# The skills CLI is pinned so a new release of it can't fail this check on its own.
set -euo pipefail

SKILLS_CLI="${SKILLS_CLI:-skills@1.7.1}"
root="$(cd "$(dirname "$0")/.." && pwd)"
source="${1:-$root}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
cd "$dir"
git init -q .

listed="$(npx -y "$SKILLS_CLI" add "$source" --list 2>&1)"
npx -y "$SKILLS_CLI" add "$source" --skill '*' --agent claude-code -y >/dev/null

status=0
for skill_dir in "$root"/plugin/skills/*/; do
  name="$(basename "$skill_dir")"
  grep -q "$name" <<<"$listed" || { echo "not listed: $name"; status=1; }
  while IFS= read -r file; do
    rel="${file#"$skill_dir"}"
    test -s ".claude/skills/$name/$rel" || { echo "missing after install: $name/$rel"; status=1; }
  done < <(find "$skill_dir" -type f)
done
[ "$status" = 0 ] && echo "all skills install from $source"
exit "$status"
