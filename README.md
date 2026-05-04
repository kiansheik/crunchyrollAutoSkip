# Crunchyroll Auto Skipper

A tiny Chrome/Chromium Manifest V3 extension that skips Crunchyroll recap and intro segments.

It works by extracting the media ID from URLs like:

```text
https://www.crunchyroll.com/pt-br/watch/G14U4MXVG/two-dragons-face-off-momonosukes-determination
https://www.crunchyroll.com/pt-br/watch/GJWU2J2VJ/will-you-remember-me
```

Then it fetches Crunchyroll's own skip-events JSON:

```text
https://static.crunchyroll.com/skip-events/production/<MEDIA_ID>.json
```

and jumps the HTML video player past `recap` and `intro` segments.

## Install locally

1. Open Chrome or Brave.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder: `crunchyroll-auto-skipper`.
6. Open a Crunchyroll episode page and play normally.

## Configure skipped segment types

Open `content.js` and edit:

```js
skipTypes: new Set(["recap", "intro"]),
```

For example, to also skip outros:

```js
skipTypes: new Set(["recap", "intro", "outro"]),
```

## Debugging

In `content.js`, set:

```js
debug: true
```

Then open DevTools on the Crunchyroll page and check the console.

## Notes

- The extension skips each segment once per episode load. If you manually rewind into a skipped intro/recap, it should not immediately fight you by skipping it again.
- When nearby skip ranges appear together, the extension jumps to the end of the later range in one seek instead of hopping through each segment one by one.
- The extension only seeks forward. It will not move playback backward to reach a skip segment.
- If Crunchyroll changes the player structure or the skip-events JSON format, `content.js` is the file to patch.
