# Privacy Policy

Effective date: 2026-05-04

Crunchyroll Auto Skipper does not collect, store, sell, or share personal information.

## What the extension does

The extension runs only on Crunchyroll watch pages that match the URL patterns declared in `manifest.json`. It reads the media ID from the current page URL, asks the bundled service worker to fetch Crunchyroll skip timing metadata for that media ID, and locally moves the HTML video player past configured recap and intro ranges.

## Data collection

The extension does not collect analytics, browsing history, account information, payment information, video history, or personal identifiers.

## Network requests

The extension makes one kind of network request: it requests skip timing JSON from:

```text
https://static.crunchyroll.com/skip-events/production/<MEDIA_ID>.json
```

That request is made directly to Crunchyroll's static asset host. The developer of this extension does not receive the request or any data from it.

## Local processing

The extension reads the current Crunchyroll watch URL and the local HTML video player's playback time so it can decide whether to skip a recap or intro segment. That processing happens in the browser.

## Third parties

This extension does not send user data to the developer or to analytics providers. The only third-party network destination used by the extension is Crunchyroll's static skip-events host described above.

## Contact

For questions or issues, use the GitHub repository:

https://github.com/kiansheik/crunchyrollAutoSkip

This project is not affiliated with, endorsed by, or sponsored by Crunchyroll.
