(() => {
  "use strict";

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

    // Only consider proactive startup skips for early segments. This keeps startup
    // recaps fast without allowing a future intro to skip real episode content.
    proactiveSkipThresholdSeconds: 120,

    // If the first skip segment begins this early, treat the lead-in as studio
    // or production credits and skip immediately instead of waiting for it.
    shortPrerollSkipThresholdSeconds: 15.0,

    // When a segment starts this far in the future, wait for normal playback to
    // reach it instead of jumping there immediately.
    proactiveSkipStartToleranceSeconds: 2.0,

    // Keep verbose while debugging. Turn off before publishing.
    debug: true,

    // Mirror content-script logs to the MV3 service worker console so the full
    // flow can be inspected from chrome://extensions.
    mirrorDebugToServiceWorker: true,

    // Avoid flooding the console with every timeupdate while still showing state.
    videoStateLogIntervalMs: 2000
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

    const entry = {
      sequence: ++debugSequence,
      at: new Date().toISOString(),
      step,
      mediaId: currentMediaId,
      path: window.location.pathname,
      fullscreen: Boolean(document.fullscreenElement),
      details: sanitizeDebugValue(details)
    };

    console.log("[Crunchyroll Auto Skipper]", entry);
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

  async function skipSegment(video, plan) {
    for (const segment of plan.segments) {
      skippedSegmentKeys.add(segmentKey(segment));
    }

    const wasPaused = video.paused;
    const types = plan.segments.map((segment) => segment.type);

    log("skip:perform:start", {
      types,
      from: video.currentTime,
      to: plan.targetTime,
      wasPaused,
      plan,
      video
    });

    try {
      video.currentTime = plan.targetTime;
      log("skip:perform:seek-set", {
        requestedTime: plan.targetTime,
        actualTime: video.currentTime,
        video
      });
    } catch (error) {
      log("skip:perform:seek-error", { error, plan, video });
      return;
    }

    showSkipOverlay(video, types);

    // If the user/player was already playing, keep it playing after the jump.
    // This may be rejected by the browser if there has not been a user gesture.
    if (!wasPaused) {
      try {
        await video.play();
        log("skip:perform:play-resumed", { video });
      } catch (error) {
        log("skip:perform:play-blocked", { error, video });
      }
    }
  }

  function proactiveSkip(video, source = "unknown") {
    const firstSegment = currentSegments[0];
    if (!firstSegment) return;

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
      log("proactive:skip:rejected", { source, reason: "already-skipped", firstSegment, video });
      return;
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
    const hasOnlyShortPreroll = firstSegment.start <= CONFIG.shortPrerollSkipThresholdSeconds;
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
      skipSegment(video, plan);
    }
  }

  function onTimeUpdate(source = "manual") {
    const video = attachedVideo || findVideo("timeupdate");

    if (!video) {
      return;
    }

    if (!currentSegments.length) {
      if (Date.now() - lastVideoStateLogAt >= CONFIG.videoStateLogIntervalMs) {
        lastVideoStateLogAt = Date.now();
        log("skip:decision:no-segments", { source, video });
      }
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
      if (plan) { skipSegment(video, plan); return; }
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
        routePollMs: CONFIG.routePollMs,
        mirrorDebugToServiceWorker: CONFIG.mirrorDebugToServiceWorker
      },
      snapshot: getDebugSnapshot()
    });

    installRuntimeMessageHandler();

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
    pollTimer = window.setInterval(() => tick("poll"), CONFIG.routePollMs);

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
