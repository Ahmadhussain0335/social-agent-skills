# Changelog

## 0.1.0 (2026-10-24)

First release, published to npm as `social-agent-skills` (commands `social-agent-skills` and `social-skills`).

### Installer CLI

- `social-skills install | uninstall | list | update | doctor`.
- Detects Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot and Cursor, and writes the
  fewest skill directories that cover the selected agents.
- Never overwrites a skill you edited; `--force` moves your copy to a backup first.

### Skills (29)

- **Shared:** `social-core` (voice, formatting, disclosure, single-post approval).
- **YouTube:** pipeline, research, script, visuals, assemble (FFmpeg), metadata, upload,
  with three mandatory approval checkpoints.
- **Meta:** `meta-auth`, `facebook-post`, `instagram-post`, `threads-post`.
- **WhatsApp Cloud API:** templates, opt-in broadcasts with cost estimates, a
  business-scoped support bot with no AI model.
- **More platforms:** X, LinkedIn (personal profile), Pinterest, TikTok (drafts by
  default), Telegram, Discord, Bluesky, Mastodon, Google Business Profile, Reddit (draft only).
- **Cross-platform:** content repurpose, content calendar, analytics, inbox with approved replies.

### Safety

- Official APIs only; every publish needs the user's approval in an interactive terminal,
  bound to SHA-256 hashes of the approved files.
- Credentials from environment variables only; tokens stored with mode 0600 outside any
  git repository; output passes through a secret redactor.
- No install scripts; dependencies pinned; publishing via npm trusted publishing.

### Known limitations

- Live-tested against real accounts: YouTube. All other platforms are covered by tests
  against simulated APIs and have not yet been run against real accounts.
