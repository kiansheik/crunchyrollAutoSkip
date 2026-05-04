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

    // Turn this on while debugging.
    debug: false
  };

  let currentMediaId = null;
  let currentSegments = [];
  let skippedSegmentKeys = new Set();
  let attachedVideo = null;
  let pollTimer = null;

  function log(...args) {
    if (CONFIG.debug) {
      console.log("[Crunchyroll Auto Skipper]", ...args);
    }
  }

  function getMediaIdFromLocation() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const watchIndex = parts.indexOf("watch");

    if (watchIndex === -1 || !parts[watchIndex + 1]) {
      return null;
    }

    return parts[watchIndex + 1];
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

  async function fetchSkipEvents(mediaId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "GET_SKIP_EVENTS", mediaId },
        (response) => {
          if (chrome.runtime.lastError) {
            log("runtime error", chrome.runtime.lastError.message);
            resolve(null);
            return;
          }

          if (!response || !response.ok) {
            log("fetch failed", response && response.error);
            resolve(null);
            return;
          }

          resolve(response.data || null);
        }
      );
    });
  }

  async function loadEpisode(mediaId) {
    currentMediaId = mediaId;
    currentSegments = [];
    skippedSegmentKeys = new Set();

    log("loading media", mediaId);

    const skipJson = await fetchSkipEvents(mediaId);
    currentSegments = normalizeSegments(skipJson);

    log("segments", currentSegments);
    attachToVideoWhenReady();
  }

  function findVideo() {
    // Crunchyroll currently uses a normal HTMLVideoElement under the player.
    // If there are multiple videos, prefer the one with the greatest duration.
    const videos = [...document.querySelectorAll("video")];

    if (!videos.length) {
      return null;
    }

    return videos
      .filter((video) => !Number.isNaN(video.duration))
      .sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] || videos[0];
  }

  function attachToVideoWhenReady() {
    const video = findVideo();

    if (!video || video === attachedVideo) {
      return;
    }

    if (attachedVideo) {
      attachedVideo.removeEventListener("timeupdate", onTimeUpdate);
      attachedVideo.removeEventListener("seeking", onTimeUpdate);
      attachedVideo.removeEventListener("loadedmetadata", onTimeUpdate);
    }

    attachedVideo = video;
    attachedVideo.addEventListener("timeupdate", onTimeUpdate);
    attachedVideo.addEventListener("seeking", onTimeUpdate);
    attachedVideo.addEventListener("loadedmetadata", onTimeUpdate);

    log("attached to video");
    onTimeUpdate();
  }

  function segmentKey(segment) {
    return `${currentMediaId}:${segment.type}:${segment.start}:${segment.end}`;
  }

  function shouldSkip(video, segment) {
    const t = video.currentTime;

    if (!Number.isFinite(t)) {
      return false;
    }

    if (skippedSegmentKeys.has(segmentKey(segment))) {
      return false;
    }

    if (t < segment.start || t >= segment.end) {
      return false;
    }

    if ((segment.end - t) <= CONFIG.nearEndToleranceSeconds) {
      return false;
    }

    if (getTargetTime(video, segment.end) <= t) {
      return false;
    }

    return true;
  }

  function getTargetTime(video, segmentEnd) {
    return Math.min(
      segmentEnd + CONFIG.endPaddingSeconds,
      Number.isFinite(video.duration) ? Math.max(video.duration - 0.1, 0) : segmentEnd + CONFIG.endPaddingSeconds
    );
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
      return null;
    }

    return { segments, targetTime };
  }

  async function skipSegment(video, plan) {
    for (const segment of plan.segments) {
      skippedSegmentKeys.add(segmentKey(segment));
    }

    const wasPaused = video.paused;

    log("skipping", {
      types: plan.segments.map((segment) => segment.type),
      from: video.currentTime,
      to: plan.targetTime,
      wasPaused
    });

    video.currentTime = plan.targetTime;

    // If the user/player was already playing, keep it playing after the jump.
    // This may be rejected by the browser if there has not been a user gesture.
    if (!wasPaused) {
      try {
        await video.play();
      } catch (error) {
        log("play() after skip was blocked", error);
      }
    }
  }

  function onTimeUpdate() {
    const video = attachedVideo || findVideo();

    if (!video || !currentSegments.length) {
      return;
    }

    const segment = currentSegments.find((candidate) => shouldSkip(video, candidate));

    if (segment) {
      const plan = buildSkipPlan(video, segment);

      if (plan) {
        skipSegment(video, plan);
      }
    }
  }

  function tick() {
    const mediaId = getMediaIdFromLocation();

    if (mediaId && mediaId !== currentMediaId) {
      loadEpisode(mediaId);
    }

    attachToVideoWhenReady();
  }

  function start() {
    if (pollTimer) {
      return;
    }

    tick();
    pollTimer = window.setInterval(tick, CONFIG.routePollMs);

    // Also react quickly to DOM changes during Crunchyroll's SPA navigation/player load.
    const observer = new MutationObserver(() => {
      tick();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  start();
})();
