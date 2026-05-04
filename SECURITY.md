# Security Policy

Crunchyroll Auto Skipper is a small extension with no accounts, analytics, or developer-owned backend.

## Supported Versions

Security fixes should target the current `main` branch unless the project begins publishing separate release branches.

## Reporting a Vulnerability

If you find a vulnerability, open a GitHub issue with a minimal description first:

https://github.com/kiansheik/crunchyrollAutoSkip/issues

Do not include active cookies, authentication tokens, payment data, or private account details in public reports.

Useful vulnerability reports include:

- Browser and version.
- Extension version or commit SHA.
- Steps to reproduce.
- Impact.
- Whether the issue requires a malicious page, a Crunchyroll watch page, or a crafted skip-events response.

## Security Design Goals

- No remote executable code.
- No analytics or telemetry.
- Minimal host permissions.
- Local-only playback decisions.
- No collection of Crunchyroll credentials or user account data.

If a proposed feature weakens these goals, it should be discussed in an issue before implementation.
