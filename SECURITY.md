# Security policy

## Reporting

Report vulnerabilities privately through GitHub Security Advisories on
https://github.com/Ahmadhussain0335/social-agent-skills/security/advisories/new .
Do not open a public issue for security problems.

## Scope

In scope: credential handling, token storage, log redaction, approval checkpoint
bypasses, installer file handling, and supply-chain issues in the published package.

## Design notes

- Credentials come from environment variables and files outside the repository.
- Tokens are written atomically with mode 0600; the writer refuses paths inside a git
  work tree.
- Script output passes through a redactor for bearer tokens, Google OAuth tokens, API
  keys and secret environment variable values.
- Approval checkpoints are an integrity and audit mechanism, not an access control
  boundary: anyone who can write a project's `state.json` can forge an approval.
- Releases use npm trusted publishing with provenance; there is no long-lived npm token.
