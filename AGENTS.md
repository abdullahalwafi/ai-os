@/root/.codex/RTK.md
@/root/AUDIOONE_CURRENT_CONTEXT.md

## Project workflow

- Work only on the user's current milestone; preserve production services.
- After each completed and verified progress increment, commit and push to
  `git@github.com:abdullahalwafi/ai-os.git` unless the user asks otherwise.
- Review staged changes before committing. Never commit `.env`, credentials,
  private keys, logs, or `node_modules`. Never force-push without explicit approval.
- Report verification results and the pushed commit. If push is blocked, report
  the blocker and keep the local commit intact.
