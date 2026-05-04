# Crunchyroll Auto Skipper

A small Chrome/Chromium Manifest V3 extension that automatically skips Crunchyroll recap and intro segments while you watch episodes.

This project is open source and intentionally simple. Forks, bug reports, timing edge cases, browser compatibility fixes, and careful pull requests are welcome.

This project is not affiliated with, endorsed by, or sponsored by Crunchyroll.

## What it does

- Runs on Crunchyroll watch URLs such as `https://www.crunchyroll.com/watch/...` and localized watch URLs such as `https://www.crunchyroll.com/pt-br/watch/...`.
- Extracts the media ID after `/watch/`.
- Fetches Crunchyroll's public skip-events JSON for that media ID.
- Watches the local HTML `<video>` player.
- Seeks forward when playback enters a configured `recap` or `intro` segment.
- Collapses nearby skip ranges into one forward-only seek, so it does not hop segment by segment.
- Skips each segment once per episode load, so manual rewinds are less likely to fight the user.

By default, it skips:

```js
skipTypes: new Set(["recap", "intro"]),
```

You can also configure it locally to skip additional segment types, such as `outro`, by editing `content.js`.

## Privacy

The extension does not collect analytics, browsing history, account information, or personal identifiers.

It makes one kind of remote request:

```text
https://static.crunchyroll.com/skip-events/production/<MEDIA_ID>.json
```

That request goes directly to Crunchyroll's static asset host. The developer of this extension does not receive user data. See [PRIVACY.md](./PRIVACY.md) for the full policy.

## Install Locally

1. Clone or download this repository.
2. Open Chrome, Brave, Edge, or another Chromium browser.
3. Go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select this repository folder.
7. Open a Crunchyroll episode page and play normally.

After editing files, reload the extension from `chrome://extensions` before testing again.

## Development

This repo has no package install step. It is plain JavaScript plus a Manifest V3 service worker.

Run syntax checks:

```sh
make check
```

Build the Chrome Web Store upload zip:

```sh
make package
```

The zip is written to `dist/`.

## Project Structure

```text
manifest.json                    Chrome extension manifest
service_worker.js                Background service worker that fetches skip-events JSON
content.js                       Content script that finds the video element and performs skips
PRIVACY.md                       Privacy policy for users and store review
CONTRIBUTING.md                  Contributor and fork workflow
docs/chrome-web-store-publishing.md
                                 Store listing copy, assets, privacy answers, and publish steps
assets/logo.svg                  Editable source logo
assets/icons/                    PNG icons used by the manifest
assets/store/                    Store listing screenshot and promo assets
```

## How Skipping Works

The content script extracts the media ID from the current URL, asks the service worker for the matching skip-events JSON, normalizes supported segments, and listens to the video element's `timeupdate`, `seeking`, and `loadedmetadata` events.

A skip only happens when the current playback time is inside a configured segment and the computed target time is strictly later than the current time. The extension never seeks backward to reach a skip segment.

## Contributing

Contributions are encouraged. Good first contributions include:

- Testing the extension on more Crunchyroll locales and URL formats.
- Reporting episodes where skip-events metadata behaves unexpectedly.
- Improving browser compatibility for Chromium-based browsers.
- Adding narrowly scoped options without collecting user data.
- Improving store assets, documentation, or installation instructions.

Before opening a pull request, read [CONTRIBUTING.md](./CONTRIBUTING.md), run `make check`, and manually test with the unpacked extension.

If you fork this project for your own preferences, keep the privacy promise clear and update the name/branding if you publish a separate store listing.

For a deeper implementation overview, see [docs/architecture.md](./docs/architecture.md).

Please also read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) and [SECURITY.md](./SECURITY.md) before opening sensitive reports or larger changes.

## Chrome Web Store Publishing

Store preparation notes live in [docs/chrome-web-store-publishing.md](./docs/chrome-web-store-publishing.md).

That document includes:

- Listing title, summary, and description copy.
- Privacy tab answers.
- Store asset paths.
- Reviewer test instructions.
- A step-by-step free publishing checklist.

## Debugging

In `content.js`, temporarily set:

```js
debug: true
```

Then open DevTools on the Crunchyroll page and check the console for `[Crunchyroll Auto Skipper]` messages.

Turn debug logging off before publishing a release.

## License

MIT. See [LICENSE](./LICENSE).
