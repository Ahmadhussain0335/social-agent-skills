# Instructions for agents without Agent Skills support

This repository contains Agent Skills in `skills/<name>/SKILL.md`. If your agent does not
load skills automatically, use them manually:

1. Read `skills/social-core/SKILL.md` before drafting or publishing any social media
   content, and follow it.
2. For YouTube work, read `skills/youtube-pipeline/SKILL.md` and follow its steps. When a
   step names another skill, read that skill's `SKILL.md`.
3. Run scripts with Node.js 22.12 or newer from the skill's directory, for example
   `node skills/youtube-upload/scripts/upload.mjs --help`. Every script supports `--help`.
4. Never publish, upload or send anything without the user's explicit approval of that
   exact content. Never run an approval command for the user and never edit `state.json`.
5. Use only official platform APIs through these scripts. Do not use browser automation,
   scraping or unofficial clients.
6. Never print credentials. Refer to them by environment variable name.

## Working on this repository

- Node.js 22.12+, TypeScript, ESM. `npm run check` must pass.
- Skill scripts live in `src/scripts/` and are bundled into `skills/*/scripts/*.mjs` by
  `npm run build`; never edit the `.mjs` files directly.
- Keep `SKILL.md` files agent-neutral: do not name a specific agent's tools.
- New platforms implement `Platform` from `src/shared/platform.ts`, register in
  `src/platforms/index.ts`, and ship `references/setup.md` in every platform skill.
