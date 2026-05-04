# Contributing

Thanks for improving Crunchyroll Auto Skipper. The project is deliberately small: the best contributions keep the extension easy to audit, privacy-preserving, and reliable for normal episode playback.

Forks are welcome. If you build a variant for your own workflow, keep the user-facing privacy claims accurate and update the name/branding if you publish a separate store listing.

## Ground Rules

- Keep the extension single-purpose: skip supported Crunchyroll recap and intro segments.
- Prefer the narrowest permissions that solve the problem.
- Do not add analytics, tracking, ads, remote JavaScript, or developer-owned telemetry.
- Do not add bundled copyrighted Crunchyroll media, screenshots, logos, or episode frames.
- Keep changes understandable for people who want to audit the extension before installing it.
- Document behavior changes in `README.md` or `docs/` when users or contributors need to know about them.

## Local Setup

No dependency install is required.

1. Clone your fork.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repo folder.
5. Open a Crunchyroll episode page and test playback.

After changing JavaScript or manifest files, reload the extension in `chrome://extensions`.

## Checks

Run:

```sh
make check
```

This runs syntax checks for:

- `content.js`
- `service_worker.js`

Build the upload package with:

```sh
make package
```

## Manual Test Checklist

Before opening a pull request, test the behavior that your change touches.

For skip behavior changes, check:

- A normal episode page loads without console errors.
- The extension does nothing before skip metadata is loaded.
- Playback only seeks forward.
- Resuming after an intro or recap does not seek backward.
- Manual rewind behavior is understandable and documented if changed.
- A page with missing skip-events JSON still plays normally.

For manifest or permission changes, check:

- The extension loads unpacked without manifest errors.
- New permissions are necessary and justified in docs.
- `docs/chrome-web-store-publishing.md` still matches the manifest.

For architecture context, read `docs/architecture.md`.

## Pull Request Expectations

A good PR includes:

- A narrow description of the problem.
- The behavior change and why it is needed.
- Manual test notes.
- Screenshots only when they are useful and do not include copyrighted episode frames.
- Documentation updates for user-facing behavior.

Small PRs are much easier to review than broad rewrites.

## Issue Reports

Useful bug reports include:

- Browser and version.
- Operating system.
- Crunchyroll URL format, with account-specific tokens removed.
- Whether the episode has Crunchyroll skip buttons in the native player.
- What happened and what you expected.
- Console logs from DevTools if `debug: true` was enabled.

Do not paste account cookies, auth tokens, payment details, or private account information.

## Release Notes

If your change affects users, add a short note to the pull request summary. Maintainers can copy that into GitHub releases or Chrome Web Store update notes.
