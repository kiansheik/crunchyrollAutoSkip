# Maintainer Checklist

Use this before tagging a release or uploading a new Chrome Web Store package.

## Before Release

1. Review user-facing behavior changes.
2. Update `README.md` if install, privacy, or skip behavior changed.
3. Update `PRIVACY.md` if any data handling changed.
4. Update `docs/chrome-web-store-publishing.md` if manifest permissions, store copy, or test instructions changed.
5. Confirm `manifest.json` has the intended `version`.
6. Run:

```sh
make check
make package
```

7. Load the repo unpacked from `chrome://extensions`.
8. Test at least one supported Crunchyroll watch URL.
9. Inspect the package:

```sh
unzip -l dist/crunchyroll-auto-skipper-<version>.zip
```

10. Upload the zip from `dist/` to the Chrome Developer Dashboard.

## Versioning

Chrome extension versions must be updated in `manifest.json` before uploading a new store package.

Use simple semantic-ish versions:

- Patch: bug fixes and docs that ship with the package.
- Minor: user-visible behavior changes or small features.
- Major: permission model changes or large behavior changes.

## Store Review Notes

Keep the review explanation precise:

- The extension has a single purpose.
- It uses no remote code.
- It fetches JSON timing metadata only.
- It does not collect or transmit user data to the developer.
- It uses narrow host permissions.

## After Release

1. Confirm the Chrome Web Store listing is live.
2. Update `README.md` with the listing URL if this is the first public release.
3. Create a GitHub release with the same version number.
4. Include a short changelog and the packaged zip if you want GitHub users to inspect it directly.
