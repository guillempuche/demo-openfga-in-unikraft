# Agent skills

Skills in the open [Agent Skills](https://agentskills.io) format (`<name>/SKILL.md`), shared by every coding agent that works on this repository. `.agents/skills/` is the canonical location.

| Skill | What it covers | Source |
| --- | --- | --- |
| `unikraft` | The `unikraft` CLI: build, run, instances, tunnels, secrets-safe output | Vendored from [guillempuche/ai-skill-unikraft](https://github.com/guillempuche/ai-skill-unikraft) (MIT), version 2.1.2, commit `ff98c46`. Refresh with `./scripts/sync-agent-skills.sh [ref]`; don't edit it here. |
| `git-commit-messages` | This repo's commit message format | Maintained here |
| `write-comments` | How to write code comments | Maintained here |

Which agent finds what:

| Agent | Reads | Gets |
| --- | --- | --- |
| Codex | `.agents/skills/` | all three |
| OpenCode | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` | all three |
| Mastra Code | `.mastracode/skills/`, `.claude/skills/`, `.agents/skills/` | all three |
| Claude Code | `.claude/skills/` (symlinks to the repo skills here) and installed plugins | `git-commit-messages`, `write-comments`; `unikraft` comes from the `unikraft@ai-standards` plugin, which `.claude/settings.json` registers and enables (Claude Code offers to install it when you trust the folder; manually: `/plugin marketplace add guillempuche/ai-standards`, then `/plugin install unikraft@ai-standards`) |

`unikraft` is deliberately not linked into `.claude/skills/`, so Claude Code users with the plugin don't get it twice.
