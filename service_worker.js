const DEBUG = true;
let debugSequence = 0;

function log(step, details = undefined) {
  if (!DEBUG) {
    return;
  }

  console.log("[Crunchyroll Auto Skipper SW]", {
    sequence: ++debugSequence,
    at: new Date().toISOString(),
    step,
    details
  });
}

function describeSender(sender) {
  if (!sender) {
    return null;
  }

  return {
    id: sender.id,
    origin: sender.origin,
    url: sender.url,
    frameId: sender.frameId,
    documentId: sender.documentId,
    tab: sender.tab
      ? {
          id: sender.tab.id,
          url: sender.tab.url,
          title: sender.tab.title,
          active: sender.tab.active,
          windowId: sender.tab.windowId
        }
      : null
  };
}

function fetchSkipEvents(mediaId, options, sendResponse) {
  const url = `https://static.crunchyroll.com/skip-events/production/${encodeURIComponent(mediaId)}.json`;
  const startedAt = Date.now();
  const cacheMode = options.bypassHttpCache ? "reload" : "force-cache";

  log("skip-events:fetch:start", {
    mediaId,
    url,
    cacheMode
  });

  fetch(url, {
    method: "GET",
    credentials: "omit",
    cache: cacheMode,
    headers: {
      "Accept": "application/json"
    }
  })
    .then(async (response) => {
      const elapsedMs = Date.now() - startedAt;
      log("skip-events:fetch:response", {
        mediaId,
        status: response.status,
        ok: response.ok,
        elapsedMs,
        contentType: response.headers.get("content-type")
      });

      if (response.status === 404) {
        return { ok: true, data: null, status: 404 };
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      log("skip-events:fetch:json", {
        mediaId,
        keys: data && typeof data === "object" ? Object.keys(data) : [],
        elapsedMs: Date.now() - startedAt
      });
      return { ok: true, data, status: response.status };
    })
    .then((response) => {
      log("skip-events:fetch:complete", {
        mediaId,
        ok: response.ok,
        status: response.status,
        hasData: Boolean(response.data),
        elapsedMs: Date.now() - startedAt
      });
      sendResponse(response);
    })
    .catch((error) => {
      const response = {
        ok: false,
        error: String(error && error.message ? error.message : error)
      };
      log("skip-events:fetch:error", {
        mediaId,
        response,
        elapsedMs: Date.now() - startedAt
      });
      sendResponse(response);
    });
}

chrome.runtime.onInstalled.addListener((details) => {
  log("lifecycle:onInstalled", details);
});

chrome.runtime.onStartup.addListener(() => {
  log("lifecycle:onStartup");
});

chrome.action.onClicked.addListener((tab) => {
  log("action:clicked", {
    tab: tab
      ? {
          id: tab.id,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId
        }
      : null
  });

  if (!tab || typeof tab.id !== "number") {
    log("action:force-resync:skipped", { reason: "missing-tab-id" });
    return;
  }

  chrome.tabs.sendMessage(
    tab.id,
    {
      type: "CR_SKIPPER_FORCE_RESYNC",
      reason: "toolbar-action"
    },
    (response) => {
      if (chrome.runtime.lastError) {
        log("action:force-resync:error", {
          tabId: tab.id,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      log("action:force-resync:response", {
        tabId: tab.id,
        response
      });
    }
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  log("message:received", {
    type,
    mediaId: message && message.mediaId,
    bypassHttpCache: Boolean(message && message.bypassHttpCache),
    sender: describeSender(sender)
  });

  if (type === "CR_SKIPPER_DEBUG_LOG") {
    log("content-script:debug", {
      entry: message.entry,
      sender: describeSender(sender)
    });
    sendResponse({ ok: true });
    return false;
  }

  if (type !== "GET_SKIP_EVENTS" || !message.mediaId) {
    log("message:ignored", {
      type,
      reason: "unsupported-message"
    });
    return false;
  }

  const mediaId = String(message.mediaId).trim();
  if (!/^[A-Z0-9]+$/i.test(mediaId)) {
    const response = { ok: false, error: "Invalid media id" };
    log("skip-events:invalid-media-id", {
      mediaId,
      response
    });
    sendResponse(response);
    return false;
  }

  fetchSkipEvents(
    mediaId,
    {
      bypassHttpCache: Boolean(message.bypassHttpCache)
    },
    sendResponse
  );

  // Keep the message channel open for the async fetch.
  return true;
});
