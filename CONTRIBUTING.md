# Contributing

## Ground rules

- Official platform APIs only. Pull requests that add browser automation, scraping,
  reverse-engineered endpoints or unofficial client libraries for posting are rejected.
- Every publishing path needs a human approval checkpoint bound to the exact content.
- No shared or default credentials. Users bring their own developer apps.
- No install scripts (`preinstall`, `install`, `postinstall`) in `package.json`.
- Pin new dependencies to exact versions and justify each one in the pull request.

## Adding a platform

Single-post platforms implement one contract, `PostPlatform` in
`src/platforms/posting.ts`, which gives them socialkit-content-calendar, repurpose, analytics and
inbox support for free.

1. Create `src/platforms/<id>/index.ts`: a `check()` that enforces the documented limits
   (cite the doc URL in a comment), a `publish()`, and optional `metrics()`, `comments()`,
   `reply()` and `approvalNotes()`. Call `registerPostPlatform()`.
2. Import it in `src/platforms/all-posting.ts`.
3. Credentials: environment variables only. Use `src/shared/oauth.ts` for OAuth
   (paste-back for HTTPS-only redirects, loopback with PKCE where 127.0.0.1 is allowed)
   and `src/shared/api.ts` for REST calls. Non-GET requests must not retry except on 429.
4. Add a doctor entry in `src/platforms/env-platforms.ts`.
5. Add `src/scripts/platforms/<id>-publish.ts` (and an auth script if needed) and list
   them in `tsup.config.ts`.
6. Add `skills/socialkit-<id>-post/SKILL.md` with `metadata.platform` and `metadata.requires: socialkit-social-core`.
7. Write `docs/platforms/<id>-setup.md` once and register it in `tools/sync-refs.mjs`.
8. Add tests in `test/` for the limits and the request shape, then
   `npm run build && npm run check`, and commit the generated scripts.

## Skill authoring

- Frontmatter uses only the fields in the Agent Skills spec.
- Description: what the skill does and when to use it, with concrete trigger words.
- Body: steps, output contract, failure handling. Under 500 lines; move detail to
  `references/`.
- Agent-neutral wording: write "run `node scripts/x.mjs`", not a specific agent's tool name.

## Commits

Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`.
