# social-skills

Agent Skills for social media work that keep a person in the loop. The skills follow the
open [Agent Skills specification](https://agentskills.io/specification) and work with
Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot, Cursor and other compatible agents.

Included:

- **YouTube:** research, script, visuals, assembly with FFmpeg, metadata, and upload
  through the official YouTube Data API v3.
- **Facebook Pages, Instagram, Threads:** single posts through the official Graph and
  Threads APIs, with one shared Meta sign-in.
- **WhatsApp Business Platform (Cloud API):** templates, opt-in broadcasts with cost
  estimates, and a business-scoped support bot.

## Principles

- **Official APIs only.** No browser automation, scraping or unofficial clients for
  posting. Pull requests that add them are rejected.
- **A person approves every publish.** Publishing scripts refuse to run until the user
  approves the exact files and settings in their own terminal.
- **Bring your own credentials.** Every user creates their own developer app. This
  package never ships shared keys.
- **Node only.** Every script runs with Node.js 22.12 or newer. No Python.

## Install

Two ways to install, same skills.

From GitHub, with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add Ahmadhussain0335/social-agent-skills
```

From npm, with this package's installer:

```sh
npx @ahmadhussain/social-skills install
```

The installer detects installed agents, asks which to target, and copies the skills into
the directories those agents read:

| Agent | Project | Global |
| - | - | - |
| Claude Code | `.claude/skills` | `~/.claude/skills` |
| OpenAI Codex | `.agents/skills` | `~/.agents/skills` |
| Gemini CLI | `.agents/skills` or `.gemini/skills` | `~/.agents/skills` or `~/.gemini/skills` |
| GitHub Copilot | `.agents/skills`, `.github/skills` or `.claude/skills` | `~/.agents/skills` or `~/.copilot/skills` |
| Cursor | `.agents/skills`, `.cursor/skills`, `.claude/skills` | `~/.agents/skills`, `~/.cursor/skills`, `~/.claude/skills` |

It writes the fewest directories that cover every selected agent, so `.agents/skills` is
shared rather than copied per agent. Sources for each path are cited in `src/agents.ts`.

### Commands

```sh
social-skills install   [--project | --global] [--agent <id...>] [--skill <name...>] [--force] [--yes]
social-skills uninstall [--project | --global] [--agent <id...>] [--skill <name...>] [--force]
social-skills list
social-skills update    [--project | --global] [--force]
social-skills doctor
```

Agent ids: `claude-code`, `codex`, `gemini-cli`, `github-copilot`, `cursor`.

Installed skills carry a `.social-skills.json` manifest with file hashes. If you edit an
installed skill, `install`, `update` and `uninstall` leave it alone and show a diff. With
`--force` your copy is moved to `~/.config/social-skills/backups/` before it is replaced.

`doctor` checks the Node.js version, FFmpeg, credentials, token file permissions and
installed skill versions.

## Skills

| Skill | What it does |
| - | - |
| `social-core` | Voice, tone, formatting, disclosure and approval rules shared by all skills |
| `youtube-pipeline` | Runs the whole workflow and stops at three approval checkpoints |
| `youtube-research` | Searches YouTube and summarises top videos and gaps (API key) |
| `youtube-script` | Writes the script with sources and visual cues |
| `youtube-visuals` | Builds a shot list from the script; the user supplies the assets |
| `youtube-assemble` | Renders the MP4 with FFmpeg |
| `youtube-metadata` | Title, description, chapters, tags, thumbnail brief; validated |
| `youtube-upload` | Uploads the approved video; private by default |
| `meta-auth` | Connects your own Meta app to your Pages, Instagram and Threads |
| `facebook-post` | Text, link, photo(s) or video on a Facebook Page; scheduling |
| `instagram-post` | Image, carousel, Reel or Story on a Business/Creator account |
| `threads-post` | Text (with link), image, video or carousel on Threads |
| `whatsapp-templates` | Drafts templates and submits them for Meta review |
| `whatsapp-broadcast` | Sends an approved template to opted-in contacts, with a cost estimate |
| `whatsapp-support-bot` | Answers FAQs and order status from an approved knowledge base |

Ask your agent something like "make a YouTube video about BLE pairing for beginners" and
it will follow `youtube-pipeline`.

## Why there are human checkpoints

YouTube removes monetization from channels that publish mass-produced or repetitive
content without meaningful human involvement (its
[inauthentic content policy](https://support.google.com/youtube/answer/1311392)). A fully
automated channel is exactly what that policy targets. The pipeline therefore stops for
approval after:

1. the script draft,
2. the final title, description and thumbnail,
3. the final video and upload settings, before upload.

Each approval records SHA-256 hashes of the files it covers and must be given in an
interactive terminal. The upload script uploads only if every hash still matches. This
makes approval visible and auditable; it is not a security boundary against someone who
can edit the project's `state.json`.

Uploads default to `private`. Use `--schedule <ISO date>` to publish later, and
`--synthetic-media` to disclose realistic AI-generated or altered content (sets
`status.containsSyntheticMedia`).

## YouTube setup

Full steps: [docs/platforms/youtube-setup.md](docs/platforms/youtube-setup.md). Short
version:

1. Create a Google Cloud project and enable YouTube Data API v3.
2. Configure the OAuth consent screen and create an OAuth client of type **Desktop app**.
3. Save the client JSON outside any repository, `chmod 600` it, and set
   `YT_CLIENT_SECRET_PATH`.
4. Run the `youtube-upload` skill's `scripts/auth.mjs` once.
5. For research, create an API key restricted to YouTube Data API v3 and set `YT_API_KEY`.

Limits to know:

- `videos.insert` and `search.list` each have a default bucket of 100 calls per day;
  other calls share 10,000 units per day. Quotas reset at midnight Pacific Time. More
  quota needs Google's API compliance audit.
- OAuth apps in "Testing" status get refresh tokens that expire after 7 days.
- Custom thumbnails need a verified channel.
- Older guidance said uploads from unverified API projects are locked to private.
  Google's `videos.insert` documentation (updated 2026-10-15) says that no longer
  applies. The upload script still warns if YouTube sets a different privacy status than
  you requested.

## Meta setup (Facebook, Instagram, Threads)

Full steps: [docs/platforms/meta-setup.md](docs/platforms/meta-setup.md). Your own app
works on your own accounts without App Review. Limits to know:

- Facebook: Pages only, never personal profiles.
- Instagram: Business or Creator account linked to a Facebook Page. Images must be at a
  public https URL; Reels can be uploaded from a local file. No scheduling via the API.
- Threads: images and videos must be at a public https URL. No scheduling via the API.
- Sign-in is "open link, paste back the URL": Threads does not allow localhost redirects.

Every post lives in a folder with `post.json` and media, and is published only after you
approve that exact post in your terminal (`social-core` `scripts/post.mjs --approve`).

## WhatsApp setup

Full steps: [docs/platforms/whatsapp-setup.md](docs/platforms/whatsapp-setup.md).
Official Cloud API only; no whatsapp-web.js, Baileys or personal-account automation.

- Broadcasts go only to contacts with a recorded opt-in, honour opt-outs, and skip US
  numbers for marketing templates (WhatsApp does not deliver those).
- The broadcast cost estimate uses a `rates.json` you copy from Meta's rate card; Meta
  has no pricing API.
- The support bot has no AI model. Meta's WhatsApp Business terms (section 4.7, from
  2026-01-15) prohibit general-purpose AI assistants; the bot answers only from your
  approved knowledge base and hands everything else to a person.
- From 2026-10-01, service replies are charged after 1,000 free per month per number.

## FFmpeg

`youtube-assemble` looks for FFmpeg in this order:

1. `FFMPEG_PATH`
2. the `ffmpeg-static` binary from a global install (`npm install -g @ahmadhussain/social-skills`)
3. `ffmpeg` on `PATH`

`ffmpeg-static` downloads its binary at install time and is GPL-3.0-or-later licensed;
it is a separate executable and is not bundled into this package's code.

## Security

- Credentials are read from environment variables only and are never logged; output is
  passed through a redactor.
- OAuth tokens are stored in your user config directory (`~/.config/social-skills/` or
  `%APPDATA%\social-skills\`) with mode 0600, and never inside a git repository.
- The package has no install scripts. Dependencies are pinned to exact versions.
- Releases are published from GitHub Actions with npm trusted publishing and provenance.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```sh
nvm use            # Node 22
npm ci
npm run build      # syncs shared reference docs and bundles skill scripts
npm run check      # lint, typecheck, tests
npm link           # makes the social-skills command available locally
```

Skill scripts are written in TypeScript under `src/scripts/` and bundled into
`skills/*/scripts/*.mjs`. The bundles are committed so installing from GitHub works
without a build; CI fails if they are out of date.

## Roadmap

- Phase 3: LinkedIn, X, TikTok, Pinterest
- Phase 4: Telegram, Discord, Reddit (draft-only), Bluesky, Mastodon, Google Business Profile
- Phase 5: cross-platform repurposing, content calendar, analytics, inbox

Out of scope: Snapchat organic posting, and any automation of personal WhatsApp,
personal Facebook profiles or Instagram DMs through unofficial methods.

## Licence

MIT
