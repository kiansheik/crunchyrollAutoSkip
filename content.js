(() => {
  "use strict";

  if (globalThis.__crAutoSkipperActive) {
    console.log("[Crunchyroll Auto Skipper] duplicate injection detected; asking existing script to resync");
    window.dispatchEvent(new CustomEvent("cr-skipper-force-resync", {
      detail: { reason: "duplicate-injection" }
    }));
    return;
  }

  globalThis.__crAutoSkipperActive = true;

  /**
   * Crunchyroll Auto Skipper
   *
   * Super simple behavior:
   * 1. Extract media ID from /watch/<MEDIA_ID>/...
   * 2. Ask the service worker to fetch:
   *    https://static.crunchyroll.com/skip-events/production/<MEDIA_ID>.json
   * 3. When the video reaches a known recap/intro segment, jump to its end.
   */

  const CONFIG = {
    // Add "outro" or "preview" here if you later want those skipped too.
    skipTypes: new Set(["recap", "intro"]),

    // Jump a tiny bit after the segment end to avoid landing exactly on a boundary.
    endPaddingSeconds: 0.25,

    // If we are already within this many seconds of the segment end, do not bother skipping.
    nearEndToleranceSeconds: 1.0,

    // Collapse nearby skip ranges into one jump instead of hopping segment by segment.
    chainGapToleranceSeconds: 10.0,

    // How often to re-check for SPA route changes and video availability.
    routePollMs: 750,

    // Keep route polling disabled while debugging resume/startup races. History
    // events, DOM mutations, and the toolbar resync still refresh state.
    enableRoutePoll: false,

    // Only consider proactive startup skips for early segments. This keeps startup
    // recaps fast without allowing a future intro to skip real episode content.
    proactiveSkipThresholdSeconds: 120,

    // If the first skip segment begins this early, treat the lead-in as studio
    // or production credits and skip immediately instead of waiting for it.
    shortPrerollSkipThresholdSeconds: 15.0,

    // When a segment starts this far in the future, wait for normal playback to
    // reach it instead of jumping there immediately.
    proactiveSkipStartToleranceSeconds: 2.0,

    // Disabled while debugging resume behavior. With this off, the extension
    // only skips after playback is actually inside a segment, except for the
    // short studio-credit preroll case below.
    proactiveSkipEnabled: false,

    // Keep the Toei/studio producer-card shortcut even while broad proactive
    // skipping is disabled. This still waits for playback to start first.
    shortPrerollProactiveSkipEnabled: true,

    // Avoid deciding anything from loadedmetadata/canplay before Crunchyroll has
    // applied its own resume point.
    requirePlaybackStartedBeforeSkip: true,

    // Keep verbose while debugging. Turn off before publishing.
    debug: true,

    // Mirror content-script logs to the MV3 service worker console so the full
    // flow can be inspected from chrome://extensions.
    mirrorDebugToServiceWorker: true,

    // Avoid flooding the console with every timeupdate while still showing state.
    videoStateLogIntervalMs: 2000,

    // A seek is only considered successful after the player stays near the
    // requested target for this long. Crunchyroll can reset early seeks while
    // the next episode is still hydrating.
    skipConfirmDelayMs: 2500,

    // If the player did not land on the target, retry at this cadence.
    skipRetryDelayMs: 500,

    // Accept tiny differences between requested and reported playback time.
    skipConfirmToleranceSeconds: 0.75,

    // After a confirmed skip, keep watching briefly for Crunchyroll resetting
    // playback back before the skipped segment.
    skipRollbackWatchMs: 10000,

    // Hard loop breakers. If Crunchyroll keeps rejecting the same seek, stop
    // fighting it for a while instead of trapping playback in repeated jumps.
    maxPendingSkipAttempts: 10,
    maxPendingSkipAgeMs: 25000,
    maxSkipPlanAttempts: 6,
    skipAttemptWindowMs: 30000,
    skipLoopSuppressMs: 90000
  };

  let currentMediaId = null;
  let currentSegments = [];
  let skippedSegmentKeys = new Set();
  let attachedVideo = null;
  let pollTimer = null;
  let observer = null;
  let loadSequence = 0;
  let debugSequence = 0;
  let lastVideoStateLogAt = 0;
  let lastVideoScanLogAt = 0;
  let lastProactiveLogAt = 0;
  let pendingSkip = null;
  let skipRetryTimer = null;
  let confirmedSkipWatch = null;
  let skipPlanAttemptRecords = new Map();
  let suppressedSegmentKeys = new Map();
  let nextPendingSkipId = 1;
  let lastSuppressedSkipLogAt = 0;
  let playbackStartedForMedia = false;
  let lastWaitingForPlayLogAt = 0;
  const preloadedIds = new Set();
  const videoDebugIds = new WeakMap();
  let nextVideoDebugId = 1;
  const VIDEO_EVENTS = [
    "timeupdate",
    "seeking",
    "seeked",
    "loadedmetadata",
    "loadeddata",
    "durationchange",
    "canplay",
    "play",
    "pause",
    "emptied",
    "waiting"
  ];

  function sanitizeDebugValue(value, depth = 0) {
    if (depth > 3) {
      return "[depth-limit]";
    }

    if (value instanceof HTMLVideoElement) {
      return describeVideo(value);
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeDebugValue(item, depth + 1));
    }

    if (value && typeof value === "object") {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "function") {
          continue;
        }
        result[key] = sanitizeDebugValue(item, depth + 1);
      }
      return result;
    }

    return value;
  }

  function formatLogValue(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "number") {
      return Number.isFinite(value) ? String(Number(value.toFixed(3))) : String(value);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return JSON.stringify(value.length > 140 ? `${value.slice(0, 137)}...` : value);
    return JSON.stringify(value);
  }

  function flattenLogDetails(value, prefix = "", output = []) {
    if (output.length >= 36 || value === undefined) {
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
      if (output.length >= 36) break;
      if (item === undefined || typeof item === "function") continue;
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        flattenLogDetails(item, nextPrefix, output);
      } else {
        flattenLogDetails(item, nextPrefix, output);
      }
    }

    return output;
  }

  function formatDetailsForLog(details) {
    if (details === undefined) {
      return "";
    }

    const parts = flattenLogDetails(sanitizeDebugValue(details));
    return parts.length ? ` ${parts.join(" ")}` : "";
  }

  function mirrorLogToServiceWorker(entry) {
    if (!CONFIG.mirrorDebugToServiceWorker) {
      return;
    }

    try {
      chrome.runtime.sendMessage(
        {
          type: "CR_SKIPPER_DEBUG_LOG",
          entry
        },
        () => {
          // Consume lastError so debug mirroring never creates console noise if
          // the service worker is unavailable during extension reloads.
          void chrome.runtime.lastError;
        }
      );
    } catch (err) {
      // The extension context can be invalidated while reloading unpacked builds.
    }
  }

  function log(step, details = undefined) {
    if (!CONFIG.debug) {
      return;
    }

    const sequence = ++debugSequence;
    const entry = {
      sequence,
      at: new Date().toISOString(),
      step,
      mediaId: currentMediaId,
      path: window.location.pathname,
      fullscreen: Boolean(document.fullscreenElement),
      details: sanitizeDebugValue(details)
    };
    entry.line = `[Crunchyroll Auto Skipper] #${entry.sequence} ${entry.at} ${step}`
      + ` media=${entry.mediaId || "none"} path=${entry.path || "/"} fullscreen=${entry.fullscreen ? "yes" : "no"}`
      + formatDetailsForLog(details);

    console.log(entry.line);
    mirrorLogToServiceWorker(entry);
  }

  function detachVideo(reason) {
    if (!attachedVideo) {
      return;
    }

    const previousVideo = attachedVideo;
    for (const eventName of VIDEO_EVENTS) {
      previousVideo.removeEventListener(eventName, onVideoEvent);
    }
    attachedVideo = null;
    log("video:detached", { reason, video: previousVideo });
  }

  function teardown(reason = "teardown") {
    log("extension:teardown", { reason });
    clearPendingSkip(`teardown:${reason}`);
    clearConfirmedSkipWatch(`teardown:${reason}`);
    clearLoopBreakerState(`teardown:${reason}`);
    playbackStartedForMedia = false;
    lastWaitingForPlayLogAt = 0;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    detachVideo(reason);
  }

  function getMediaIdFromLocation() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const watchIndex = parts.indexOf("watch");

    if (watchIndex === -1 || !parts[watchIndex + 1]) {
      return null;
    }

    return parts[watchIndex + 1];
  }

  function getVideoDebugId(video) {
    if (!videoDebugIds.has(video)) {
      videoDebugIds.set(video, nextVideoDebugId++);
    }
    return videoDebugIds.get(video);
  }

  function getVideoScore(video) {
    const rect = video.getBoundingClientRect();
    const fullscreenElement = document.fullscreenElement;
    const inFullscreen = Boolean(
      fullscreenElement && (fullscreenElement === video || fullscreenElement.contains(video))
    );
    const visibleArea = Math.max(rect.width, 0) * Math.max(rect.height, 0);
    const hasFiniteDuration = Number.isFinite(video.duration) && video.duration > 0;

    return {
      inFullscreen,
      visibleArea,
      visible: visibleArea > 0,
      notEnded: !video.ended,
      readyState: video.readyState,
      hasFiniteDuration,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      duration: hasFiniteDuration ? video.duration : null
    };
  }

  function describeVideo(video) {
    if (!video) {
      return null;
    }

    const rect = video.getBoundingClientRect();
    const score = getVideoScore(video);

    return {
      debugId: getVideoDebugId(video),
      attached: video === attachedVideo,
      currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
      paused: video.paused,
      ended: video.ended,
      seeking: video.seeking,
      readyState: video.readyState,
      networkState: video.networkState,
      playbackRate: video.playbackRate,
      muted: video.muted,
      currentSrc: video.currentSrc || video.src || "",
      rect: {
        width: Number(rect.width.toFixed(1)),
        height: Number(rect.height.toFixed(1)),
        left: Number(rect.left.toFixed(1)),
        top: Number(rect.top.toFixed(1))
      },
      score
    };
  }

  function getDebugSnapshot() {
    return {
      href: window.location.href,
      mediaIdFromLocation: getMediaIdFromLocation(),
      currentMediaId,
      segmentCount: currentSegments.length,
      segments: currentSegments,
      skippedSegmentKeys: [...skippedSegmentKeys],
      pendingSkip: pendingSkip ? sanitizeDebugValue(pendingSkip) : null,
      confirmedSkipWatch: confirmedSkipWatch ? sanitizeDebugValue(confirmedSkipWatch) : null,
      suppressedSegmentKeys: getSuppressedSegmentSnapshot(),
      skipPlanAttemptRecords: getSkipPlanAttemptSnapshot(),
      playbackStartedForMedia,
      attachedVideo: describeVideo(attachedVideo),
      videos: [...document.querySelectorAll("video")].map(describeVideo)
    };
  }

  function normalizeSegments(skipJson) {
    if (!skipJson || typeof skipJson !== "object") {
      return [];
    }

    return Object.values(skipJson)
      .filter((entry) => {
        return entry
          && typeof entry === "object"
          && CONFIG.skipTypes.has(entry.type)
          && Number.isFinite(Number(entry.start))
          && Number.isFinite(Number(entry.end))
          && Number(entry.end) > Number(entry.start);
      })
      .map((entry) => ({
        type: entry.type,
        start: Number(entry.start),
        end: Number(entry.end)
      }))
      .sort((a, b) => a.start - b.start);
  }

  async function cacheGet(mediaId) {
    log("cache:get:start", { mediaId });
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(`skip:${mediaId}`, (result) => {
          if (chrome.runtime.lastError) {
            log("cache:get:error", { mediaId, error: chrome.runtime.lastError.message });
            resolve(null);
            return;
          }
          const cached = result[`skip:${mediaId}`] ?? null;
          log("cache:get:complete", { mediaId, hit: Boolean(cached) });
          resolve(cached);
        });
      } catch (err) {
        log("cache:get:exception", { mediaId, error: err });
        teardown("cache-get-exception");
        resolve(null);
      }
    });
  }

  function cacheSet(mediaId, data) {
    try {
      chrome.storage.local.set({ [`skip:${mediaId}`]: data });
      log("cache:set", { mediaId, hasData: Boolean(data) });
    } catch (err) {
      log("cache:set:exception", { mediaId, error: err });
      teardown("cache-set-exception");
    }
  }

  async function fetchFromNetwork(mediaId, options = {}) {
    log("network:request:start", {
      mediaId,
      bypassHttpCache: Boolean(options.bypassHttpCache)
    });
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "GET_SKIP_EVENTS",
            mediaId,
            bypassHttpCache: Boolean(options.bypassHttpCache)
          },
          (response) => {
            if (chrome.runtime.lastError) {
              log("network:request:runtime-error", {
                mediaId,
                error: chrome.runtime.lastError.message
              });
              resolve(null);
              return;
            }

            if (!response || !response.ok) {
              log("network:request:failed", {
                mediaId,
                response
              });
              resolve(null);
              return;
            }

            log("network:request:complete", {
              mediaId,
              status: response.status,
              hasData: Boolean(response.data)
            });
            resolve(response.data || null);
          }
        );
      } catch (err) {
        log("network:request:exception", { mediaId, error: err });
        teardown("network-request-exception");
        resolve(null);
      }
    });
  }

  async function fetchSkipEvents(mediaId, options = {}) {
    const cached = options.forceNetwork ? null : await cacheGet(mediaId);
    if (cached) {
      log("skip-events:loaded-from-cache", { mediaId });
      return cached;
    }
    if (options.forceNetwork) {
      log("skip-events:cache-bypassed", { mediaId });
    }
    const data = await fetchFromNetwork(mediaId, {
      bypassHttpCache: Boolean(options.forceNetwork)
    });
    if (data) cacheSet(mediaId, data);
    log("skip-events:loaded-from-network", { mediaId, hasData: Boolean(data) });
    return data;
  }

  function getNextEpisodeMediaId() {
    const link = document.querySelector('[data-t="next-episode"] a[href*="/watch/"]');
    if (!link) {
      return null;
    }
    const parts = link.getAttribute("href").split("/").filter(Boolean);
    const watchIndex = parts.indexOf("watch");
    return watchIndex !== -1 && parts[watchIndex + 1] ? parts[watchIndex + 1] : null;
  }

  async function preloadNextEpisode() {
    const nextId = getNextEpisodeMediaId();
    if (!nextId || preloadedIds.has(nextId)) return;
    preloadedIds.add(nextId);
    log("preload:next:start", { nextId });
    const cached = await cacheGet(nextId);
    if (cached) {
      log("preload:next:already-cached", { nextId });
      return;
    }
    const data = await fetchFromNetwork(nextId);
    if (data) cacheSet(nextId, data);
    log("preload:next:complete", { nextId, hasData: Boolean(data) });
  }

  async function loadEpisode(mediaId, options = {}) {
    const requestId = ++loadSequence;
    const previousMediaId = currentMediaId;
    currentMediaId = mediaId;
    currentSegments = [];
    skippedSegmentKeys = new Set();
    clearPendingSkip(`episode-load:${mediaId}`);
    clearConfirmedSkipWatch(`episode-load:${mediaId}`);
    clearLoopBreakerState(`episode-load:${mediaId}`);
    playbackStartedForMedia = false;
    lastWaitingForPlayLogAt = 0;
    lastVideoStateLogAt = 0;

    log("episode:load:start", {
      mediaId,
      previousMediaId,
      requestId,
      reason: options.reason || "route-change",
      forceNetwork: Boolean(options.forceNetwork)
    });

    const skipJson = await fetchSkipEvents(mediaId, options);

    if (requestId !== loadSequence || currentMediaId !== mediaId) {
      log("episode:load:stale-response", {
        mediaId,
        requestId,
        activeRequestId: loadSequence,
        activeMediaId: currentMediaId
      });
      return;
    }

    currentSegments = normalizeSegments(skipJson);

    log("episode:load:segments", {
      mediaId,
      requestId,
      rawKeys: skipJson && typeof skipJson === "object" ? Object.keys(skipJson) : [],
      segmentCount: currentSegments.length,
      segments: currentSegments
    });
    attachToVideoWhenReady("episode-load");
    onTimeUpdate("episode-load");
    preloadNextEpisode();
  }

  function sortVideoCandidates(a, b) {
    const scoreA = a.score;
    const scoreB = b.score;

    return Number(scoreB.inFullscreen) - Number(scoreA.inFullscreen)
      || Number(scoreB.visible) - Number(scoreA.visible)
      || Number(scoreB.notEnded) - Number(scoreA.notEnded)
      || scoreB.readyState - scoreA.readyState
      || Number(scoreB.hasFiniteDuration) - Number(scoreA.hasFiniteDuration)
      || scoreB.visibleArea - scoreA.visibleArea
      || (scoreA.currentTime ?? Number.POSITIVE_INFINITY) - (scoreB.currentTime ?? Number.POSITIVE_INFINITY)
      || (scoreB.duration ?? 0) - (scoreA.duration ?? 0);
  }

  function findVideo(reason = "find-video") {
    const videos = [...document.querySelectorAll("video")];
    const now = Date.now();
    const isNoisyReason = reason === "timeupdate" || reason === "mutation" || reason === "poll";
    const shouldLogScan = !isNoisyReason || now - lastVideoScanLogAt >= 5000;

    if (!videos.length) {
      if (shouldLogScan) {
        lastVideoScanLogAt = now;
        log("video:find:none", { reason });
      }
      return null;
    }

    const candidates = videos
      .map((video, index) => ({
        index,
        video,
        score: getVideoScore(video),
        description: describeVideo(video)
      }))
      .sort(sortVideoCandidates);

    if (shouldLogScan) {
      lastVideoScanLogAt = now;
      log("video:find:candidates", {
        reason,
        selectedDebugId: candidates[0] ? getVideoDebugId(candidates[0].video) : null,
        candidates: candidates.map((candidate) => candidate.description)
      });
    }

    return candidates[0] ? candidates[0].video : null;
  }

  function attachToVideoWhenReady(reason = "attach") {
    const video = findVideo(reason);

    if (!video || video === attachedVideo) {
      if (video && Date.now() - lastVideoStateLogAt >= CONFIG.videoStateLogIntervalMs) {
        lastVideoStateLogAt = Date.now();
        log("video:attach:unchanged", { reason, video });
      }
      return;
    }

    detachVideo(`replace:${reason}`);

    attachedVideo = video;
    for (const eventName of VIDEO_EVENTS) {
      attachedVideo.addEventListener(eventName, onVideoEvent);
    }

    log("video:attached", { reason, video: attachedVideo });
    onTimeUpdate(`attached:${reason}`);
  }

  function onVideoEvent(event) {
    if (event.type === "play") {
      playbackStartedForMedia = true;
      log("video:playback-started", { video: event.currentTarget });
      onTimeUpdate("play");
      return;
    }

    if (event.type === "timeupdate") {
      if (Date.now() - lastVideoStateLogAt >= CONFIG.videoStateLogIntervalMs) {
        lastVideoStateLogAt = Date.now();
        log("video:event:timeupdate", { video: event.currentTarget });
      }
    } else {
      log("video:event", { type: event.type, video: event.currentTarget });
    }

    if (
      event.type === "timeupdate"
      || event.type === "seeking"
      || event.type === "seeked"
      || event.type === "loadedmetadata"
      || event.type === "loadeddata"
      || event.type === "durationchange"
      || event.type === "canplay"
    ) {
      onTimeUpdate(event.type);
    }
  }

  function segmentKey(segment) {
    return `${currentMediaId}:${segment.type}:${segment.start}:${segment.end}`;
  }

  function clearSkipRetryTimer() {
    if (!skipRetryTimer) {
      return;
    }

    clearTimeout(skipRetryTimer);
    skipRetryTimer = null;
  }

  function clearPendingSkip(reason) {
    if (!pendingSkip) {
      clearSkipRetryTimer();
      return;
    }

    log("skip:pending:cleared", {
      reason,
      pendingSkip
    });
    pendingSkip = null;
    clearSkipRetryTimer();
  }

  function clearConfirmedSkipWatch(reason) {
    if (!confirmedSkipWatch) {
      return;
    }

    log("skip:confirmed-watch:cleared", {
      reason,
      confirmedSkipWatch
    });
    confirmedSkipWatch = null;
  }

  function clearLoopBreakerState(reason) {
    const suppressedCount = suppressedSegmentKeys.size;
    const attemptRecordCount = skipPlanAttemptRecords.size;

    if (suppressedCount || attemptRecordCount) {
      log("skip:loop-breaker:cleared", {
        reason,
        suppressedCount,
        attemptRecordCount
      });
    }

    suppressedSegmentKeys = new Map();
    skipPlanAttemptRecords = new Map();
    lastSuppressedSkipLogAt = 0;
  }

  function clearExpiredSuppressedSegments(now = Date.now()) {
    for (const [key, expiresAtMs] of suppressedSegmentKeys.entries()) {
      if (expiresAtMs <= now) {
        suppressedSegmentKeys.delete(key);
      }
    }
  }

  function getSuppressedSegmentSnapshot() {
    clearExpiredSuppressedSegments();
    return [...suppressedSegmentKeys.entries()].map(([key, expiresAtMs]) => ({
      key,
      expiresAtMs
    }));
  }

  function getSkipPlanAttemptSnapshot() {
    return [...skipPlanAttemptRecords.entries()].map(([key, record]) => ({
      key,
      firstAttemptAtMs: record.firstAttemptAtMs,
      lastAttemptAtMs: record.lastAttemptAtMs,
      attempts: record.attempts,
      segmentKeys: record.segmentKeys
    }));
  }

  function isSegmentSuppressed(key) {
    clearExpiredSuppressedSegments();
    return suppressedSegmentKeys.has(key);
  }

  function hasSuppressedSegment(segmentKeys) {
    return segmentKeys.some((key) => isSegmentSuppressed(key));
  }

  function logSuppressedSkipBlocked(source, reason, details = {}) {
    const now = Date.now();
    if (now - lastSuppressedSkipLogAt < CONFIG.videoStateLogIntervalMs) {
      return;
    }

    lastSuppressedSkipLogAt = now;
    log("skip:loop-breaker:blocked", {
      source,
      reason,
      ...details,
      suppressedSegmentKeys: getSuppressedSegmentSnapshot()
    });
  }

  function suppressSegmentKeys(segmentKeys, reason, details = {}) {
    const now = Date.now();
    const expiresAtMs = now + CONFIG.skipLoopSuppressMs;
    const keys = [...new Set(segmentKeys)];

    for (const key of keys) {
      suppressedSegmentKeys.set(key, expiresAtMs);
      skippedSegmentKeys.add(key);
    }

    log("skip:loop-breaker:suppressed", {
      reason,
      suppressMs: CONFIG.skipLoopSuppressMs,
      expiresAtMs,
      segmentKeys: keys,
      ...details
    });
  }

  function skipPlanKey(segmentKeys) {
    return segmentKeys.join("|");
  }

  function recordSkipPlanAttempt(segmentKeys, source) {
    clearExpiredSuppressedSegments();

    if (hasSuppressedSegment(segmentKeys)) {
      logSuppressedSkipBlocked(source, "segment-temporarily-suppressed", {
        segmentKeys
      });
      return false;
    }

    const now = Date.now();
    const key = skipPlanKey(segmentKeys);
    let record = skipPlanAttemptRecords.get(key);
    if (!record || now - record.firstAttemptAtMs > CONFIG.skipAttemptWindowMs) {
      record = {
        firstAttemptAtMs: now,
        lastAttemptAtMs: now,
        attempts: 0,
        segmentKeys: [...segmentKeys]
      };
    }

    record.attempts += 1;
    record.lastAttemptAtMs = now;
    record.segmentKeys = [...segmentKeys];
    skipPlanAttemptRecords.set(key, record);

    if (record.attempts > CONFIG.maxSkipPlanAttempts) {
      suppressSegmentKeys(segmentKeys, "too-many-skip-plan-attempts", {
        source,
        attempts: record.attempts,
        maxAttempts: CONFIG.maxSkipPlanAttempts,
        attemptWindowMs: CONFIG.skipAttemptWindowMs
      });
      return false;
    }

    return true;
  }

  function abandonPendingSkip(reason, source) {
    if (!pendingSkip) {
      return;
    }

    suppressSegmentKeys(pendingSkip.segmentKeys, reason, {
      source,
      pendingSkip
    });
    clearPendingSkip(reason);
  }

  function shouldAbandonPendingSkip(source) {
    if (!pendingSkip) {
      return false;
    }

    const ageMs = Date.now() - pendingSkip.createdAtMs;
    if (pendingSkip.attempts >= CONFIG.maxPendingSkipAttempts) {
      abandonPendingSkip("too-many-pending-skip-attempts", source);
      return true;
    }

    if (ageMs >= CONFIG.maxPendingSkipAgeMs) {
      abandonPendingSkip("pending-skip-too-old", source);
      return true;
    }

    return false;
  }

  function startConfirmedSkipWatch(source, confirmedSkip) {
    confirmedSkipWatch = {
      id: confirmedSkip.id,
      mediaId: confirmedSkip.mediaId,
      segmentKeys: [...confirmedSkip.segmentKeys],
      segments: confirmedSkip.segments,
      types: [...confirmedSkip.types],
      targetTime: confirmedSkip.targetTime,
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + CONFIG.skipRollbackWatchMs
    };

    log("skip:confirmed-watch:start", {
      source,
      watchMs: CONFIG.skipRollbackWatchMs,
      confirmedSkipWatch
    });
  }

  function unmarkCurrentEpisodeSegments(reason) {
    const removedKeys = [];
    for (const segment of currentSegments) {
      const key = segmentKey(segment);
      if (skippedSegmentKeys.delete(key)) {
        removedKeys.push(key);
      }
    }

    if (removedKeys.length) {
      log("skip:segments-unmarked", {
        reason,
        removedKeys
      });
    }
  }

  function retryConfirmedSkipAfterRollback(video, source, reason) {
    const watch = confirmedSkipWatch;
    if (!watch) {
      return false;
    }

    clearConfirmedSkipWatch(reason);
    for (const key of watch.segmentKeys) {
      skippedSegmentKeys.delete(key);
    }

    const plan = {
      segments: watch.segments,
      targetTime: watch.targetTime
    };

    log("skip:confirmed-watch:rollback", {
      source,
      reason,
      currentTime: video && video.currentTime,
      targetTime: watch.targetTime,
      plan,
      video
    });
    skipSegment(video, plan, `rollback:${source}`);
    return true;
  }

  function recoverRolledBackSkip(video, source) {
    if (!confirmedSkipWatch) {
      return false;
    }

    if (confirmedSkipWatch.mediaId !== currentMediaId) {
      clearConfirmedSkipWatch("media-changed");
      return false;
    }

    if (Date.now() > confirmedSkipWatch.expiresAtMs) {
      clearConfirmedSkipWatch("rollback-watch-expired");
      return false;
    }

    if (!video || !Number.isFinite(video.currentTime)) {
      return false;
    }

    if (video.currentTime >= confirmedSkipWatch.targetTime - CONFIG.skipConfirmToleranceSeconds) {
      return false;
    }

    return retryConfirmedSkipAfterRollback(video, source, "playback-rolled-back-before-target");
  }

  function recoverSkippedSegmentStillPlaying(video, source) {
    if (!video || !currentSegments.length || !Number.isFinite(video.currentTime)) {
      return false;
    }

    const t = video.currentTime;
    const segment = currentSegments.find((candidate) => {
      const key = segmentKey(candidate);
      if (!skippedSegmentKeys.has(key)) {
        return false;
      }

      return t >= candidate.start
        && t < candidate.end
        && (candidate.end - t) > CONFIG.nearEndToleranceSeconds;
    });

    if (!segment) {
      return false;
    }

    const key = segmentKey(segment);
    if (isSegmentSuppressed(key)) {
      logSuppressedSkipBlocked(source, "marked-skipped-segment-still-playing", {
        currentTime: t,
        segment,
        key,
        video
      });
      return false;
    }

    log("skip:marked-skipped-segment-still-playing", {
      source,
      currentTime: t,
      segment,
      skippedSegmentKeys: [...skippedSegmentKeys],
      video
    });

    unmarkCurrentEpisodeSegments("marked-skipped-segment-still-playing");
    clearConfirmedSkipWatch("marked-skipped-segment-still-playing");

    const plan = buildSkipPlan(video, segment);
    if (!plan) {
      return false;
    }

    skipSegment(video, plan, `stale-skipped-state:${source}`);
    return true;
  }

  function canEvaluateSkipDecisions(video, source) {
    if (!video) {
      return false;
    }

    if (!Number.isFinite(video.currentTime)) {
      return false;
    }

    if (!playbackStartedForMedia && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      playbackStartedForMedia = true;
      log("video:playback-started:inferred", {
        source,
        currentTime: video.currentTime,
        readyState: video.readyState,
        video
      });
    }

    if (CONFIG.requirePlaybackStartedBeforeSkip && !playbackStartedForMedia) {
      const now = Date.now();
      if (now - lastWaitingForPlayLogAt >= CONFIG.videoStateLogIntervalMs) {
        lastWaitingForPlayLogAt = now;
        log("skip:decision:waiting-for-play", {
          source,
          currentTime: video.currentTime,
          paused: video.paused,
          readyState: video.readyState,
          video
        });
      }
      return false;
    }

    return true;
  }

  function samePendingPlan(plan, segmentKeys) {
    if (!pendingSkip || pendingSkip.mediaId !== currentMediaId) {
      return false;
    }

    if (pendingSkip.segmentKeys.length !== segmentKeys.length) {
      return false;
    }

    return pendingSkip.segmentKeys.every((key, index) => key === segmentKeys[index])
      && Math.abs(pendingSkip.targetTime - plan.targetTime) <= CONFIG.skipConfirmToleranceSeconds;
  }

  function isPendingSkipConfirmed(video) {
    if (!pendingSkip || !video || pendingSkip.mediaId !== currentMediaId) {
      return false;
    }

    if (Date.now() < pendingSkip.confirmAfterMs) {
      return false;
    }

    const t = video.currentTime;
    return Number.isFinite(t)
      && t >= pendingSkip.targetTime - CONFIG.skipConfirmToleranceSeconds;
  }

  function confirmPendingSkip(video, source) {
    if (!pendingSkip) {
      return false;
    }

    if (pendingSkip.mediaId !== currentMediaId) {
      clearPendingSkip("media-changed-before-confirm");
      return false;
    }

    if (!isPendingSkipConfirmed(video)) {
      return false;
    }

    for (const key of pendingSkip.segmentKeys) {
      skippedSegmentKeys.add(key);
    }

    log("skip:pending:confirmed", {
      source,
      pendingSkip,
      actualTime: video.currentTime,
      video
    });

    const confirmedSkip = {
      id: pendingSkip.id,
      mediaId: pendingSkip.mediaId,
      segmentKeys: [...pendingSkip.segmentKeys],
      segments: pendingSkip.segments,
      types: [...pendingSkip.types],
      targetTime: pendingSkip.targetTime
    };
    const types = [...pendingSkip.types];
    startConfirmedSkipWatch(source, confirmedSkip);
    clearPendingSkip("confirmed");
    showSkipOverlay(video, types);
    return true;
  }

  function schedulePendingSkipRetry(source) {
    if (!pendingSkip) {
      return;
    }

    if (skipRetryTimer) {
      return;
    }

    skipRetryTimer = setTimeout(() => {
      skipRetryTimer = null;
      retryPendingSkip(`timer:${source}`);
    }, CONFIG.skipRetryDelayMs);

    log("skip:pending:retry-scheduled", {
      source,
      retryInMs: CONFIG.skipRetryDelayMs,
      pendingSkip
    });
  }

  async function attemptPendingSkip(video, source) {
    if (!pendingSkip) {
      return;
    }

    if (!video) {
      log("skip:pending:attempt-waiting-for-video", {
        source,
        pendingSkip
      });
      schedulePendingSkipRetry(source);
      return;
    }

    if (pendingSkip.mediaId !== currentMediaId) {
      clearPendingSkip("media-changed-before-attempt");
      return;
    }

    if (confirmPendingSkip(video, `${source}:before-attempt`)) {
      return;
    }

    if (shouldAbandonPendingSkip(source)) {
      return;
    }

    clearSkipRetryTimer();

    pendingSkip.attempts += 1;
    pendingSkip.lastAttemptAtMs = Date.now();
    pendingSkip.confirmAfterMs = Date.now() + CONFIG.skipConfirmDelayMs;
    pendingSkip.videoDebugId = getVideoDebugId(video);

    log("skip:pending:attempt", {
      source,
      pendingSkip,
      from: video.currentTime,
      to: pendingSkip.targetTime,
      video
    });

    try {
      video.currentTime = pendingSkip.targetTime;
      log("skip:pending:seek-set", {
        source,
        requestedTime: pendingSkip.targetTime,
        actualTime: video.currentTime,
        pendingSkip,
        video
      });
    } catch (error) {
      log("skip:pending:seek-error", {
        source,
        error,
        pendingSkip,
        video
      });
      schedulePendingSkipRetry(source);
      return;
    }

    if (!pendingSkip.wasPaused) {
      try {
        await video.play();
        log("skip:pending:play-resumed", {
          source,
          pendingSkip,
          video
        });
      } catch (error) {
        log("skip:pending:play-blocked", {
          source,
          error,
          pendingSkip,
          video
        });
      }
    }

    schedulePendingSkipRetry(source);
  }

  function retryPendingSkip(source) {
    if (!pendingSkip) {
      return false;
    }

    const video = attachedVideo || findVideo("pending-skip-retry");
    if (confirmPendingSkip(video, source)) {
      return true;
    }

    if (Date.now() - pendingSkip.lastAttemptAtMs < CONFIG.skipRetryDelayMs) {
      schedulePendingSkipRetry(source);
      return true;
    }

    attemptPendingSkip(video, source);
    return true;
  }

  function evaluateSegment(video, segment) {
    const t = video.currentTime;
    const key = segmentKey(segment);

    if (!Number.isFinite(t)) {
      return { ok: false, reason: "non-finite-current-time", key };
    }

    if (skippedSegmentKeys.has(key)) {
      return { ok: false, reason: "already-skipped", key };
    }

    if (t < segment.start) {
      return {
        ok: false,
        reason: "before-segment",
        key,
        secondsUntilStart: Number((segment.start - t).toFixed(3))
      };
    }

    if (t >= segment.end) {
      return {
        ok: false,
        reason: "after-segment",
        key,
        secondsAfterEnd: Number((t - segment.end).toFixed(3))
      };
    }

    if ((segment.end - t) <= CONFIG.nearEndToleranceSeconds) {
      return {
        ok: false,
        reason: "near-segment-end",
        key,
        secondsRemaining: Number((segment.end - t).toFixed(3))
      };
    }

    const targetTime = getTargetTime(video, segment.end);
    if (targetTime <= t) {
      return {
        ok: false,
        reason: "target-not-forward",
        key,
        targetTime,
        currentTime: t
      };
    }

    return {
      ok: true,
      reason: "inside-segment",
      key,
      targetTime
    };
  }

  function shouldSkip(video, segment) {
    return evaluateSegment(video, segment).ok;
  }

  function getTargetTime(video, segmentEnd) {
    const desiredTarget = segmentEnd + CONFIG.endPaddingSeconds;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return desiredTarget;
    }

    return Math.min(desiredTarget, Math.max(video.duration - 0.1, 0));
  }

  function buildSkipPlan(video, firstSegment) {
    let end = firstSegment.end;
    const segments = [firstSegment];

    for (const candidate of currentSegments) {
      if (candidate === firstSegment || skippedSegmentKeys.has(segmentKey(candidate))) {
        continue;
      }

      if (candidate.start < firstSegment.start || candidate.end <= end) {
        continue;
      }

      if (candidate.start > end + CONFIG.chainGapToleranceSeconds) {
        break;
      }

      segments.push(candidate);
      end = candidate.end;
    }

    const targetTime = getTargetTime(video, end);

    if (targetTime <= video.currentTime) {
      log("skip-plan:rejected", {
        reason: "target-not-forward",
        firstSegment,
        segments,
        currentTime: video.currentTime,
        targetTime,
        video
      });
      return null;
    }

    log("skip-plan:built", {
      firstSegment,
      segments,
      targetTime,
      video
    });
    return { segments, targetTime };
  }

  function showSkipOverlay(video, types) {
    const existing = document.getElementById("crskip-overlay");
    if (existing) existing.remove();

    const label = types.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" & ");

    const overlay = document.createElement("div");
    overlay.id = "crskip-overlay";

    Object.assign(overlay.style, {
      pointerEvents: "none",
      zIndex: "2147483647",
      opacity: "1",
      transition: "opacity 0.5s ease"
    });

    const fsEl = document.fullscreenElement;

    if (fsEl) {
      Object.assign(overlay.style, {
        position: "absolute",
        bottom: "80px",
        left: "24px"
      });
      fsEl.appendChild(overlay);
    } else {
      const rect = video.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      Object.assign(overlay.style, {
        position: "fixed",
        left: `${rect.left + 20}px`,
        top: `${rect.bottom - 72}px`
      });
      document.body.appendChild(overlay);
    }

    overlay.innerHTML = `<div style="
      background: rgba(240, 90, 40, 0.92);
      color: #fff;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 15px;
      font-weight: 700;
      font-family: Arial, sans-serif;
      letter-spacing: 0.3px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      gap: 6px;
    ">⏭ Skipped ${label}</div>`;

    setTimeout(() => {
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 500);
    }, 800);
  }

  function skipSegment(video, plan, source = "skip-request") {
    const segmentKeys = plan.segments.map((segment) => segmentKey(segment));
    const types = plan.segments.map((segment) => segment.type);

    if (samePendingPlan(plan, segmentKeys)) {
      log("skip:pending:already-active", {
        source,
        pendingSkip,
        plan,
        video
      });
      retryPendingSkip(`${source}:already-active`);
      return;
    }

    if (!recordSkipPlanAttempt(segmentKeys, source)) {
      return;
    }

    clearPendingSkip("replaced-by-new-skip-request");
    clearConfirmedSkipWatch("replaced-by-new-skip-request");

    pendingSkip = {
      id: nextPendingSkipId++,
      mediaId: currentMediaId,
      segmentKeys,
      segments: plan.segments,
      types,
      targetTime: plan.targetTime,
      wasPaused: video.paused,
      attempts: 0,
      createdAtMs: Date.now(),
      lastAttemptAtMs: 0,
      confirmAfterMs: 0,
      videoDebugId: getVideoDebugId(video)
    };

    log("skip:pending:created", {
      source,
      pendingSkip,
      from: video.currentTime,
      to: plan.targetTime,
      video
    });

    attemptPendingSkip(video, source);
  }

  function proactiveSkip(video, source = "unknown") {
    const firstSegment = currentSegments[0];
    if (!firstSegment) return;

    const hasOnlyShortPreroll = firstSegment.start <= CONFIG.shortPrerollSkipThresholdSeconds;
    if (!CONFIG.proactiveSkipEnabled && !(
      CONFIG.shortPrerollProactiveSkipEnabled && hasOnlyShortPreroll
    )) {
      return;
    }

    const logWaiting = (details) => {
      const now = Date.now();
      if (now - lastProactiveLogAt < CONFIG.videoStateLogIntervalMs) {
        return;
      }
      lastProactiveLogAt = now;
      log("proactive:skip:waiting", details);
    };

    const t = video.currentTime;
    const key = segmentKey(firstSegment);
    if (!Number.isFinite(t)) {
      log("proactive:skip:rejected", { source, reason: "non-finite-current-time", firstSegment, video });
      return;
    }
    if (t >= firstSegment.start) {
      return;
    }
    if (skippedSegmentKeys.has(key)) {
      if (isSegmentSuppressed(key)) {
        logSuppressedSkipBlocked(source, "short-preroll-recovery-suppressed", {
          firstSegment,
          key,
          video
        });
        return;
      }
      if (firstSegment.start <= CONFIG.shortPrerollSkipThresholdSeconds) {
        unmarkCurrentEpisodeSegments("playback-before-short-preroll-after-confirmed-skip");
      } else {
        return;
      }
    }
    if (firstSegment.start > CONFIG.proactiveSkipThresholdSeconds) {
      logWaiting({
        source,
        reason: "segment-starts-after-proactive-window",
        firstSegment,
        video
      });
      return;
    }

    const secondsUntilStart = firstSegment.start - t;
    if (secondsUntilStart > CONFIG.proactiveSkipStartToleranceSeconds && !hasOnlyShortPreroll) {
      logWaiting({
        source,
        reason: "segment-is-still-in-the-future",
        secondsUntilStart: Number(secondsUntilStart.toFixed(3)),
        shortPrerollSkipThresholdSeconds: CONFIG.shortPrerollSkipThresholdSeconds,
        firstSegment,
        video
      });
      return;
    }

    const plan = buildSkipPlan(video, firstSegment);
    if (plan) {
      log("proactive:skip:eligible", {
        source,
        reason: hasOnlyShortPreroll ? "short-preroll-before-first-segment" : "near-first-segment",
        secondsUntilStart: Number(secondsUntilStart.toFixed(3)),
        shortPrerollSkipThresholdSeconds: CONFIG.shortPrerollSkipThresholdSeconds,
        firstSegment,
        plan,
        video
      });
      skipSegment(video, plan, `proactive:${source}`);
    }
  }

  function onTimeUpdate(source = "manual") {
    const video = attachedVideo || findVideo("timeupdate");

    if (!video) {
      return;
    }

    if (!canEvaluateSkipDecisions(video, source)) {
      return;
    }

    if (recoverRolledBackSkip(video, source)) {
      return;
    }

    if (pendingSkip) {
      retryPendingSkip(`event:${source}`);
      return;
    }

    if (!currentSegments.length) {
      if (Date.now() - lastVideoStateLogAt >= CONFIG.videoStateLogIntervalMs) {
        lastVideoStateLogAt = Date.now();
        log("skip:decision:no-segments", { source, video });
      }
      return;
    }

    if (recoverSkippedSegmentStillPlaying(video, source)) {
      return;
    }

    const decisions = currentSegments.map((candidate) => ({
      segment: candidate,
      decision: evaluateSegment(video, candidate)
    }));
    const eligible = decisions.find((candidate) => candidate.decision.ok);

    if (eligible) {
      log("skip:decision:eligible", {
        source,
        segment: eligible.segment,
        decision: eligible.decision,
        video
      });
      const plan = buildSkipPlan(video, eligible.segment);
      if (plan) { skipSegment(video, plan, `timeupdate:${source}`); return; }
    }

    const interestingDecision = decisions.find((candidate) => {
      return candidate.decision.reason === "before-segment"
        || candidate.decision.reason === "near-segment-end"
        || candidate.decision.reason === "target-not-forward";
    }) || decisions[0];

    if (Date.now() - lastVideoStateLogAt >= CONFIG.videoStateLogIntervalMs) {
      lastVideoStateLogAt = Date.now();
      log("skip:decision:not-eligible", {
        source,
        currentTime: video.currentTime,
        interestingDecision,
        video
      });
    }

    proactiveSkip(video, source);
  }

  function tick(reason = "poll") {
    const mediaId = getMediaIdFromLocation();

    if (mediaId && mediaId !== currentMediaId) {
      log("route:media-change", {
        reason,
        from: currentMediaId,
        to: mediaId,
        href: window.location.href
      });
      loadEpisode(mediaId, { reason });
    } else if (!mediaId && currentMediaId) {
      log("route:left-watch-page", {
        reason,
        from: currentMediaId,
        href: window.location.href
      });
      currentMediaId = null;
      currentSegments = [];
      skippedSegmentKeys = new Set();
      clearPendingSkip("left-watch-page");
      clearConfirmedSkipWatch("left-watch-page");
      clearLoopBreakerState("left-watch-page");
      playbackStartedForMedia = false;
      lastWaitingForPlayLogAt = 0;
    }

    attachToVideoWhenReady(reason);
    preloadNextEpisode();
  }

  async function forceResync(reason = "manual") {
    log("force-resync:start", {
      reason,
      before: getDebugSnapshot()
    });

    const mediaId = getMediaIdFromLocation();
    if (!mediaId) {
      const response = {
        ok: false,
        error: "No /watch/<MEDIA_ID> route found on this page.",
        snapshot: getDebugSnapshot()
      };
      log("force-resync:no-media-id", response);
      return response;
    }

    detachVideo(`force-resync:${reason}`);
    currentMediaId = null;
    currentSegments = [];
    skippedSegmentKeys = new Set();
    clearPendingSkip(`force-resync:${reason}`);
    clearConfirmedSkipWatch(`force-resync:${reason}`);
    clearLoopBreakerState(`force-resync:${reason}`);
    playbackStartedForMedia = false;
    lastWaitingForPlayLogAt = 0;
    lastVideoStateLogAt = 0;
    lastVideoScanLogAt = 0;
    lastProactiveLogAt = 0;

    await loadEpisode(mediaId, {
      reason: `force-resync:${reason}`,
      forceNetwork: true
    });

    const response = {
      ok: true,
      mediaId,
      segmentCount: currentSegments.length,
      attachedVideo: describeVideo(attachedVideo),
      snapshot: getDebugSnapshot()
    };
    log("force-resync:complete", response);
    return response;
  }

  function installRuntimeMessageHandler() {
    try {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.type !== "CR_SKIPPER_FORCE_RESYNC") {
          return false;
        }

        log("runtime-message:force-resync", {
          message,
          sender
        });

        forceResync(message.reason || "runtime-message")
          .then(sendResponse)
          .catch((error) => {
            const response = {
              ok: false,
              error: String(error && error.message ? error.message : error)
            };
            log("runtime-message:force-resync:error", { error, response });
            sendResponse(response);
          });

        return true;
      });
      log("runtime-message:handler-installed");
    } catch (error) {
      log("runtime-message:handler-install-error", { error });
    }
  }

  function installWindowMessageHandler() {
    window.addEventListener("cr-skipper-force-resync", (event) => {
      const reason = event && event.detail && event.detail.reason
        ? event.detail.reason
        : "window-event";
      log("window-message:force-resync", { reason });
      forceResync(reason);
    });
    log("window-message:handler-installed");
  }

  function start() {
    if (pollTimer) {
      log("extension:start:already-running");
      return;
    }

    log("extension:start", {
      config: {
        skipTypes: [...CONFIG.skipTypes],
        endPaddingSeconds: CONFIG.endPaddingSeconds,
        nearEndToleranceSeconds: CONFIG.nearEndToleranceSeconds,
        chainGapToleranceSeconds: CONFIG.chainGapToleranceSeconds,
        proactiveSkipThresholdSeconds: CONFIG.proactiveSkipThresholdSeconds,
        shortPrerollSkipThresholdSeconds: CONFIG.shortPrerollSkipThresholdSeconds,
        proactiveSkipStartToleranceSeconds: CONFIG.proactiveSkipStartToleranceSeconds,
        proactiveSkipEnabled: CONFIG.proactiveSkipEnabled,
        shortPrerollProactiveSkipEnabled: CONFIG.shortPrerollProactiveSkipEnabled,
        requirePlaybackStartedBeforeSkip: CONFIG.requirePlaybackStartedBeforeSkip,
        enableRoutePoll: CONFIG.enableRoutePoll,
        routePollMs: CONFIG.routePollMs,
        mirrorDebugToServiceWorker: CONFIG.mirrorDebugToServiceWorker,
        skipConfirmDelayMs: CONFIG.skipConfirmDelayMs,
        skipRetryDelayMs: CONFIG.skipRetryDelayMs,
        skipConfirmToleranceSeconds: CONFIG.skipConfirmToleranceSeconds,
        skipRollbackWatchMs: CONFIG.skipRollbackWatchMs,
        maxPendingSkipAttempts: CONFIG.maxPendingSkipAttempts,
        maxPendingSkipAgeMs: CONFIG.maxPendingSkipAgeMs,
        maxSkipPlanAttempts: CONFIG.maxSkipPlanAttempts,
        skipAttemptWindowMs: CONFIG.skipAttemptWindowMs,
        skipLoopSuppressMs: CONFIG.skipLoopSuppressMs
      },
      snapshot: getDebugSnapshot()
    });

    installRuntimeMessageHandler();
    installWindowMessageHandler();

    // Intercept history API so we detect SPA navigation the instant Crunchyroll
    // calls pushState/replaceState, before any DOM mutation fires.
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (...args) => { origPush(...args); tick("history.pushState"); };
    history.replaceState = (...args) => { origReplace(...args); tick("history.replaceState"); };
    window.addEventListener("popstate", () => tick("popstate"));
    document.addEventListener("fullscreenchange", () => {
      log("fullscreen:change", {
        fullscreenElement: document.fullscreenElement
          ? document.fullscreenElement.tagName
          : null,
        snapshot: getDebugSnapshot()
      });
      tick("fullscreenchange");
    });

    tick("start");
    if (CONFIG.enableRoutePoll) {
      pollTimer = window.setInterval(() => tick("poll"), CONFIG.routePollMs);
    } else {
      log("route:poll:disabled");
    }

    observer = new MutationObserver(() => {
      tick("mutation");
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  start();
})();
