# Contributing

## Ground rules

- Official platform APIs only. Pull requests that add browser automation, scraping,
  reverse-engineered endpoints or unofficial client libraries for posting are rejected.
- Every publishing path needs a human approval checkpoint bound to the exact content.
- No shared or default credentials. Users bring their own developer apps.
- No install scripts (`preinstall`, `install`, `postinstall`) in `package.json`.
- Pin new dependencies to exact versions and justify each one in the pull request.

## Adding a platform

1. Implement `Platform` (`src/shared/platform.ts`) under `src/platforms/<id>/` and add it
   to `src/platforms/index.ts` so `doctor` checks it.
2. Put API logic in `src/platforms/<id>/` and script entry points in
   `src/scripts/<id>/`; add them to `tsup.config.ts`.
3. Add skills under `skills/<id>-<name>/` with `metadata.platform` and
   `metadata.requires: social-core`.
4. Write the setup guide once in `docs/platforms/<id>-setup.md` and register it in
   `tools/sync-refs.mjs`.
5. Add limits to `skills/social-core/references/platform-limits.md`.
6. `npm run build && npm run check`, and commit the generated scripts.

## Skill authoring

- Frontmatter uses only the fields in the Agent Skills spec.
- Description: what the skill does and when to use it, with concrete trigger words.
- Body: steps, output contract, failure handling. Under 500 lines; move detail to
  `references/`.
- Agent-neutral wording: write "run `node scripts/x.mjs`", not a specific agent's tool name.

## Commits

Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`.
