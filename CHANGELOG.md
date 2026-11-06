# Changelog

## 0.3.1 (2026-11-06)

### Changed

- The YouTube setup guide and `.env.example` suggest `oauth-client.json` as the file name
  for the downloaded Google OAuth client. Existing setups are unaffected:
  `YT_CLIENT_SECRET_PATH` still points to wherever the file is saved.
- Clearer wording in the YouTube resumable upload code and its error message.

## 0.3.0 (2026-11-06)

### Changed

- YouTube and Google Business Profile now call Google's REST APIs directly instead of
  bundling Google's client libraries. Skill scripts shrink from up to 1 MB to at most
  about 130 KB (all skills: 9.9 MB to 1.6 MB), and no longer contain the cloud-metadata
  and environment-scanning code from those libraries, which security scanners flagged.
  Existing YouTube token files keep working.
- The YouTube API key is sent in the `x-goog-api-key` header instead of the URL.
- The social-core approval script no longer imports every platform (858 KB to 13 KB).

### Fixed

- The X cost estimate used a global regular expression with `.test()`, which keeps state
  between calls, so the same post could alternate between the $0.015 and $0.20 estimate.

## 0.2.0 (2026-10-27)

### Changed

- All 29 skills are renamed with the `socialkit-` prefix (for example `x-post` is now
  `socialkit-x-post`). Ten of the old names were already used by other publishers on
  ClawHub, so a bare install such as `openclaw skills install x-post` could install
  someone else's skill. Every `socialkit-*` name is unique, so bare installs work:
  `openclaw skills install socialkit-youtube-pipeline`.

### Migration

- `social-skills update` moves 0.1.0 installs to the new names: it installs each renamed
  skill and removes the old copy. A copy you edited is moved to the backup folder, never
  deleted.

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
