chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GET_SKIP_EVENTS" || !message.mediaId) {
    return false;
  }

  const mediaId = String(message.mediaId).trim();
  if (!/^[A-Z0-9]+$/i.test(mediaId)) {
    sendResponse({ ok: false, error: "Invalid media id" });
    return false;
  }

  const url = `https://static.crunchyroll.com/skip-events/production/${encodeURIComponent(mediaId)}.json`;

  fetch(url, {
    method: "GET",
    credentials: "omit",
    cache: "force-cache",
    headers: {
      "Accept": "application/json"
    }
  })
    .then(async (response) => {
      if (response.status === 404) {
        return { ok: true, data: null, status: 404 };
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return { ok: true, data: await response.json(), status: response.status };
    })
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });

  // Keep the message channel open for the async fetch.
  return true;
});
