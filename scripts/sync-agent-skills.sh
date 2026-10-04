#!/usr/bin/env bash
# Refresh the vendored `unikraft` agent skill in .agents/skills/unikraft from
# its upstream repository (github.com/guillempuche/ai-skill-unikraft, MIT).
#
#   ./scripts/sync-agent-skills.sh [<git ref>]
#
# Defaults to the pinned commit below; pass `main` (or a commit) to update, then
# bump UNIKRAFT_SKILL_REF and the version in .agents/skills/README.md.
#
# Doesn't source env.sh: it needs no Unikraft profile or secrets.
set -euo pipefail

UNIKRAFT_SKILL_REF="ff98c468abe835b6b228c185226cb7fb6ac80bcc" # plugin version 2.1.2
ref="${1:-$UNIKRAFT_SKILL_REF}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/.agents/skills/unikraft"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "https://codeload.github.com/guillempuche/ai-skill-unikraft/tar.gz/$ref" | tar -xz -C "$tmp"
src="$(find "$tmp" -type d -path '*/skills/unikraft' | head -n1)"
[[ -f "$src/SKILL.md" ]] || { echo "error: skills/unikraft/SKILL.md not found at ref $ref" >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$src/." "$dest/"
echo "synced unikraft skill from ref $ref into ${dest#"$root"/}"
