# Chrome Web Store Publishing Guide

Prepared: 2026-05-04

GitHub repo: https://github.com/kiansheik/crunchyrollAutoSkip

This guide gives you the copy, asset paths, privacy answers, and manual steps to publish Crunchyroll Auto Skipper on the Chrome Web Store for free.

## What is already prepared

- Manifest store metadata: `name`, `short_name`, `description`, `homepage_url`, and PNG icons are set in `manifest.json`.
- Editable logo source: `assets/logo.svg`.
- Manifest icons: `assets/icons/icon16.png`, `assets/icons/icon32.png`, `assets/icons/icon48.png`, `assets/icons/icon128.png`.
- Store icon: use `assets/icons/icon128.png`.
- Small promo tile: use `assets/store/small-promo-440x280.png`.
- Screenshot asset: use `assets/store/screenshot-1280x800.png`.
- Privacy policy draft: `PRIVACY.md`.
- Package target: `make package`.

The SVG files are source assets only. Chrome manifest icons should be PNG/raster, not SVG.

## Store listing copy

### Title

```text
Crunchyroll Auto Skipper
```

### Summary

Use the same summary that is in `manifest.json`:

```text
Automatically skips Crunchyroll recap and intro segments while you watch episodes.
```

### Recommended category

Choose `Entertainment` if the dashboard offers it. If not, choose the closest available category such as `Tools`.

### Language

```text
English
```

### Detailed description

Paste this into the Store Listing description field:

```text
Crunchyroll Auto Skipper is a small Chrome extension that automatically skips recap and intro segments on supported Crunchyroll episode pages.

Open an episode and play normally. When playback enters a known recap or intro range, the extension seeks forward to the end of that range. If nearby skip ranges appear together, it collapses them into one forward-only jump.

Features:
- Automatic recap skipper and intro skipper for supported Crunchyroll watch pages.
- Forward-only seeking, so resuming later in an episode will not move playback backward.
- Uses Crunchyroll's public skip-events timing metadata.
- No popup, account, analytics, or tracking.
- Runs only on Crunchyroll watch URLs and static skip-events JSON.

Open source:
https://github.com/kiansheik/crunchyrollAutoSkip

Contributions, issue reports, and forks are welcome on GitHub.

This project is not affiliated with, endorsed by, or sponsored by Crunchyroll.
```

This copy intentionally uses relevant search terms in normal sentences. Do not add keyword lists or repeat the same phrase many times; Chrome Web Store policy treats excessive or irrelevant metadata as keyword spam.

### Homepage URL

```text
https://github.com/kiansheik/crunchyrollAutoSkip
```

### Support URL

```text
https://github.com/kiansheik/crunchyrollAutoSkip/issues
```

### Privacy policy URL

After you push `PRIVACY.md` to GitHub, use:

```text
https://github.com/kiansheik/crunchyrollAutoSkip/blob/main/PRIVACY.md
```

If your default branch is not `main`, change the URL to the real default branch.

## Store assets

Upload these in the Store Listing tab:

- Store icon: `assets/icons/icon128.png`
- Screenshot: `assets/store/screenshot-1280x800.png`
- Small promo tile: `assets/store/small-promo-440x280.png`
- Marquee promo tile: leave blank unless you want to create an optional `1400x560` image later.
- YouTube promo video: Chrome's docs list this as a Store Listing media field. If the dashboard marks it required, upload a short YouTube demo; otherwise leave it blank unless you want one.

The included screenshot is a clean, non-copyrighted visual explanation. If you use a live browser screenshot instead, avoid copyrighted episode frames and make sure the screenshot still shows the current behavior clearly.

## Privacy tab answers

### Single purpose description

```text
Automatically skip known recap and intro segments while the user watches supported Crunchyroll episode pages.
```

### Permission justification

For `https://static.crunchyroll.com/skip-events/production/*.json`:

```text
Needed to fetch the skip timing JSON for the current episode media ID from Crunchyroll's static skip-events host. The extension does not request broad host access.
```

For the Crunchyroll watch-page content script, if the dashboard asks:

```text
Needed to read the current Crunchyroll watch URL, find the local HTML video element, and seek forward when playback enters a recap or intro range.
```

### Remote code

Select:

```text
No, this extension does not use remote code.
```

Explanation, if a text field is shown:

```text
All executable code is bundled in the extension package. The extension fetches JSON timing data only; it does not fetch or execute remote JavaScript.
```

### Data usage

Based on the current implementation, select no collected user data categories.

Explanation, if a text field is shown:

```text
The extension does not collect, store, sell, or share user data. It processes the current watch URL and video playback time locally in the browser. It sends the media ID only to Crunchyroll's static skip-events host to retrieve timing metadata needed for the user-facing skip feature. The developer does not receive that request or any user data.
```

If you later add analytics, settings sync, logging, accounts, or any developer-owned backend, update this answer and `PRIVACY.md` before submitting a new version.

## Test instructions for reviewers

Paste this into the Test instructions tab:

```text
1. Install the extension.
2. Open a Crunchyroll episode watch page, such as https://www.crunchyroll.com/watch/G14U4MXVG/ if available in your region/account.
3. Start playback normally.
4. When playback enters a Crunchyroll-provided recap or intro skip-events range, the extension seeks forward to the end of that range.
5. The extension has no popup or account system. A Crunchyroll account may be required by Crunchyroll to play some episodes.
```

## Package locally

Run:

```sh
make package
```

That runs JavaScript syntax checks and writes:

```text
dist/crunchyroll-auto-skipper-0.1.0.zip
```

Only upload the zip from `dist/`, not the whole repository.

## Manual publish steps

1. Push the repo to GitHub so the homepage, support URL, and privacy policy URL are public.
2. Enable 2-Step Verification on the Google account you will use to publish.
3. Register a Chrome Web Store developer account in the Chrome Developer Dashboard and pay Google's one-time registration fee.
4. Run `make package`.
5. Locally smoke-test the packaged extension:
   - Open `chrome://extensions`.
   - Enable Developer mode.
   - Load the unpacked repo folder.
   - Open a Crunchyroll watch page and confirm playback still works.
6. Open the Chrome Developer Dashboard.
7. Click `Add new item`.
8. Upload `dist/crunchyroll-auto-skipper-0.1.0.zip`.
9. Fill out the Store Listing tab using the copy and assets above.
10. Fill out the Privacy tab using the answers above.
11. Fill out Distribution:
    - Visibility: `Public`
    - Pricing: free / no in-app purchases
    - Regions: all regions unless you intentionally want to limit availability
12. Fill out Test instructions using the text above.
13. Submit for review.
14. Choose automatic publishing after approval, or use deferred publishing if you want to review the approved listing before it goes live.
15. After it is published, update `README.md` with the Chrome Web Store listing URL.

## Source references checked

- Publish flow: https://developer.chrome.com/docs/webstore/publish
- Store listing fields and required graphic assets: https://developer.chrome.com/docs/webstore/cws-dashboard-listing/
- Listing quality and discovery guidance: https://developer.chrome.com/docs/webstore/best-listing
- Discovery/search behavior: https://developer.chrome.com/docs/webstore/discovery
- Privacy tab guidance: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Listing requirements and keyword spam policy: https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- Extension icon sizes and PNG guidance: https://developer.chrome.com/docs/extensions/develop/ui/configure-icons
- Developer account registration: https://developer.chrome.com/docs/webstore/register/
- 2-Step Verification requirement: https://developer.chrome.com/docs/webstore/program-policies/two-step-verification/
