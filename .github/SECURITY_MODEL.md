# Agent Flow Security Model

## Token Inventory

| Secret | Scope | Used By | Notes |
|--------|-------|---------|-------|
| `CLI_DISPATCH_PAT` | `repo` on dashboard-cli only | dashboard notify-cli.yml | Fine-grained PAT, triggers repository_dispatch |
| `CROSS_REPO_PAT` | Read on dashboard repo | agent-flow.yml prepare job | Clones dashboard to build types |
| `ANTHROPIC_API_KEY` | Anthropic API | agent-codegen + babysit | Claude Code agent |
| `OPENAI_API_KEY` | OpenAI API | agent-codegen + ai-review | Codex agent + review |
| `CURSOR_API_KEY` | Cursor API | agent-codegen | Cursor SDK agent (placeholder) |
| `GITHUB_TOKEN` | Auto-provisioned | All jobs | Minimal permissions per job |

## Access Controls

### What agents CAN do
- Modify files in `src/commands/`, `src/lib/types.ts`, `tests/`
- Run `bun test`, `bun run typecheck`, `bun run build`
- Read any file in the repository
- Push to their own agent branch

### What agents CANNOT do
- Modify `.github/workflows/` or `.github/actions/`
- Modify `types/api.d.ts` (auto-synced only)
- Modify `bun.lock` directly (must use `bun install`)
- Modify `.env*` files or anything in `secrets/`
- Add forbidden dependencies (enforced by deps-policy)
- Push to `main` or any branch other than their worktree branch
- Create/close issues or comment on other PRs
- Access network endpoints outside the allowlist

### Enforcement Layers
1. **`.agent-flow/allowed-files.json`** — declarative file allowlist
2. **`scripts/deps-policy.ts`** — CI blocks forbidden dependencies
3. **`.github/actions/security-check`** — CI blocks forbidden file modifications
4. **Branch protection** — requires all checks + human review
5. **Concurrency groups** — prevents parallel runs for same upstream release

## Rotation Schedule
- Rotate all PATs every 90 days
- Use fine-grained PATs, never classic tokens
- AI provider keys are org-level secrets with restricted repo access

## Incident Response
If an agent PR contains suspicious code:
1. Do NOT merge
2. Close the PR
3. Check workflow run logs for the agent's full session
4. Rotate any potentially exposed secrets
5. Open an incident issue with the `security` label
