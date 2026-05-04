const DEBUG = true;
let debugSequence = 0;

function formatLogValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toFixed(3))) : String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value.length > 180 ? `${value.slice(0, 177)}...` : value);
  return JSON.stringify(value);
}

function flattenLogDetails(value, prefix = "", output = []) {
  if (output.length >= 30 || value === undefined) {
    return output;
  }

  if (value === null || typeof value !== "object") {
    output.push(`${prefix || "value"}=${formatLogValue(value)}`);
    return output;
  }

  if (Array.isArray(value)) {
    output.push(`${prefix || "items"}[${value.length}]`);
    for (let index = 0; index < Math.min(value.length, 3); index += 1) {
      flattenLogDetails(value[index], `${prefix || "item"}${index}`, output);
    }
    return output;
  }

  for (const [key, item] of Object.entries(value)) {
    if (output.length >= 30) break;
    if (item === undefined || typeof item === "function") continue;
    flattenLogDetails(item, prefix ? `${prefix}.${key}` : key, output);
  }

  return output;
}

function formatDetailsForLog(details) {
  if (details === undefined) {
    return "";
  }

  const parts = flattenLogDetails(details);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function log(step, details = undefined) {
  if (!DEBUG) {
    return;
  }

  const sequence = ++debugSequence;
  console.log(`[Crunchyroll Auto Skipper SW] #${sequence} ${new Date().toISOString()} ${step}${formatDetailsForLog(details)}`);
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

  sendForceResync(tab.id, "toolbar-action", true);
});

function sendForceResync(tabId, reason, allowInjection) {
  chrome.tabs.sendMessage(
    tabId,
    {
      type: "CR_SKIPPER_FORCE_RESYNC",
      reason
    },
    (response) => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        log("action:force-resync:error", {
          tabId,
          reason,
          allowInjection,
          error
        });

        if (allowInjection && error.includes("Receiving end does not exist")) {
          injectContentScript(tabId, reason);
        }
        return;
      }

      log("action:force-resync:response", {
        tabId,
        reason,
        ok: response && response.ok,
        mediaId: response && response.mediaId,
        segmentCount: response && response.segmentCount,
        error: response && response.error
      });
    }
  );
}

function injectContentScript(tabId, reason) {
  log("action:inject-content-script:start", {
    tabId,
    reason
  });

  chrome.scripting.executeScript(
    {
      target: { tabId },
      files: ["content.js"]
    },
    () => {
      if (chrome.runtime.lastError) {
        log("action:inject-content-script:error", {
          tabId,
          reason,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      log("action:inject-content-script:complete", {
        tabId,
        reason
      });
      sendForceResync(tabId, `${reason}:after-injection`, false);
    }
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  if (type === "CR_SKIPPER_DEBUG_LOG") {
    if (DEBUG && message.entry && message.entry.line) {
      console.log(`[Crunchyroll Auto Skipper SW <= content] ${message.entry.line}`);
    }
    sendResponse({ ok: true });
    return false;
  }

  log("message:received", {
    type,
    mediaId: message && message.mediaId,
    bypassHttpCache: Boolean(message && message.bypassHttpCache),
    sender: describeSender(sender)
  });

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
