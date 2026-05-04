# Architecture

Crunchyroll Auto Skipper has two runtime scripts:

- `content.js` runs on Crunchyroll watch pages.
- `service_worker.js` runs as the Manifest V3 background service worker.

The split exists because the content script watches the page and video player, while the service worker performs the cross-origin request to Crunchyroll's static skip-events host declared in `host_permissions`.

## Runtime Flow

1. `content.js` starts on matching Crunchyroll watch URLs.
2. It extracts the media ID after `/watch/`.
3. It sends `{ type: "GET_SKIP_EVENTS", mediaId }` to the service worker.
4. `service_worker.js` validates the media ID and fetches:

```text
https://static.crunchyroll.com/skip-events/production/<MEDIA_ID>.json
```

5. `content.js` normalizes the returned JSON into sorted skip segments.
6. It finds the page's HTML `<video>` element.
7. On `timeupdate`, `seeking`, and `loadedmetadata`, it checks whether playback is inside a configured segment.
8. If a skip is needed, it seeks forward to the segment end plus a small padding.

## Segment Rules

Configured skip types live in `CONFIG.skipTypes` in `content.js`.

Current defaults:

```js
skipTypes: new Set(["recap", "intro"]),
```

A segment is eligible only when:

- Its `type` is configured.
- `start` and `end` are finite numbers.
- `end > start`.
- The current playback time is inside `[start, end)`.
- The extension has not already skipped that segment during the current episode load.
- The computed target time is strictly later than the current playback time.

## Forward-Only Behavior

The extension should never seek backward.

The forward-only guarantee is enforced in two places:

- `shouldSkip()` rejects a segment if its computed target is not later than `video.currentTime`.
- `buildSkipPlan()` returns `null` if the final planned target is not later than `video.currentTime`.

If you change seek planning, preserve both checks or replace them with an equivalent guard.

## Chained Skips

`buildSkipPlan()` collapses nearby configured skip ranges into one seek. This avoids jumping first to the end of an intro and then immediately to the end of a nearby recap, or the reverse, when Crunchyroll metadata contains adjacent ranges.

The maximum gap is controlled by:

```js
chainGapToleranceSeconds: 10.0,
```

Keep this conservative. A large gap could skip actual episode content.

## SPA Navigation

Crunchyroll behaves like a single-page application. `content.js` polls for route changes and watches DOM mutations so it can attach to a newly loaded video after navigation.

When the media ID changes, `loadEpisode()` clears current segments and the per-load skipped segment set.

## Permission Model

The manifest keeps permissions narrow:

- Content scripts run only on Crunchyroll watch pages.
- `host_permissions` covers only Crunchyroll skip-events JSON.
- There are no broad `tabs`, `webRequest`, storage, cookies, history, or scripting permissions.

If a feature requires new permissions, document why in:

- `README.md`
- `CONTRIBUTING.md`, if contributor workflow changes
- `docs/chrome-web-store-publishing.md`, for store-review answers
- `PRIVACY.md`, if data handling changes
