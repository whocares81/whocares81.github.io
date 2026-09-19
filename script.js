const CONFIG_URL = "https://api.npoint.io/e3053dbbd1114fc8febc";

const FALLBACK_URL = "changeable link";

let VIDEO_URL = FALLBACK_URL;

async function loadRemoteVideoUrl() {
  if (!CONFIG_URL) return;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller && setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(CONFIG_URL, {
      cache: "no-store",
      signal: controller ? controller.signal : undefined
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && typeof data.videoUrl === "string" && data.videoUrl.trim()) {
      VIDEO_URL = data.videoUrl.trim();
    }
  } catch (err) {
    console.warn("Could not load remote video config, keeping current URL:", err);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const HLS_JS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js";

(function() {
  "use strict";
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const bigPlayBtn = document.getElementById("bigPlayBtn");
  const loadingIndicator = document.getElementById("loadingIndicator");
  const bufferingIndicator = document.getElementById("bufferingIndicator");
  const errorState = document.getElementById("errorState");
  const retryBtn = document.getElementById("retryBtn");
  const gestureLayer = document.getElementById("gestureLayer");
  const seekFlashLeft = document.getElementById("seekFlashLeft");
  const seekFlashRight = document.getElementById("seekFlashRight");
  const controls = document.getElementById("controls");
  const progressBar = document.getElementById("progressBar");
  const bufferedFill = document.getElementById("bufferedFill");
  const playedFill = document.getElementById("playedFill");
  const hoverFill = document.getElementById("hoverFill");
  const progressHandle = document.getElementById("progressHandle");
  const hoverTime = document.getElementById("hoverTime");
  const playPauseBtn = document.getElementById("playPauseBtn");
  const muteBtn = document.getElementById("muteBtn");
  const volumeGroup = document.getElementById("volumeGroup");
  const volumeSlider = document.getElementById("volumeSlider");
  const volumeFill = document.getElementById("volumeFill");
  const volumeHandle = document.getElementById("volumeHandle");
  const currentTimeEl = document.getElementById("currentTime");
  const durationEl = document.getElementById("duration");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsMenu = document.getElementById("settingsMenu");
  const settingsBackdrop = document.getElementById("settingsBackdrop");
  const seekBackBtn = document.getElementById("seekBackBtn");
  const seekFwdBtn = document.getElementById("seekFwdBtn");
  const pipBtn = document.getElementById("pipBtn");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const speedValueLabel = document.getElementById("speedValueLabel");
  const speedOptions = document.getElementById("speedOptions");
  const qualityMenuItem = document.getElementById("qualityMenuItem");
  const qualityValueLabel = document.getElementById("qualityValueLabel");
  const qualityOptions = document.getElementById("qualityOptions");
  let hls = null;
  let isHlsJs = false;
  let usingNativeHls = false;
  let nativeVariants = [];
  let controlsTimeout = null;
  let isScrubbing = false;
  let wasPlayingBeforeScrub = false;
  let isVolumeDragging = false;
  let lastVolume = 1;
  let currentQualityLabel = "Auto";
  let hideDelay = 3e3;
  let isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  let tapTimer = null;
  let tapCount = 0;
  let networkRecoveryAttempts = 0;
  let lastTouchEndTime = 0;
  const SPEEDS = [ .5, .75, 1, 1.25, 1.5, 1.75, 2 ];
  const MAX_NETWORK_RECOVERY_ATTEMPTS = 3;
  const MANIFEST_ERROR_DETAILS = [ "manifestLoadError", "manifestLoadTimeOut", "manifestParsingError" ];
  const RESUME_STORAGE_KEY = "player:resume";
  let lastKnownTime = 0;
  let mediaRecoveryAttempts = 0;
  function formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    const pad = n => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
  }
  function setIconHidden(icon, hide) {
    icon.toggleAttribute("hidden", hide);
  }
  function syncBusyState() {
    const busy = loadingIndicator.classList.contains("is-visible") || bufferingIndicator.classList.contains("is-visible");
    player.classList.toggle("is-busy", busy);
  }
  function showLoading(show) {
    loadingIndicator.classList.toggle("is-visible", show);
    syncBusyState();
  }
  function showBuffering(show) {
    bufferingIndicator.classList.toggle("is-visible", show);
    syncBusyState();
  }
  function showError(show) {
    errorState.hidden = !show;
    if (show) {
      showLoading(false);
      showBuffering(false);
    }
  }
  function logError(context, err) {
    console.error(`[player] ${context}:`, err);
  }
  function detectType(url) {
    const clean = url.split("?")[0].toLowerCase();
    if (clean.endsWith(".m3u8")) return "hls";
    if (clean.endsWith(".webm")) return "webm";
    if (clean.endsWith(".mp4") || clean.endsWith(".m4v")) return "mp4";
    return "other";
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "true") return resolve();
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("Failed to load script: " + src)));
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      const timer = setTimeout(() => fail(new Error("Timed out loading script: " + src)), 15e3);
      function fail(err) {
        clearTimeout(timer);
        script.remove();
        reject(err);
      }
      script.onload = () => {
        clearTimeout(timer);
        script.dataset.loaded = "true";
        resolve();
      };
      script.onerror = () => fail(new Error("Failed to load script: " + src));
      document.head.appendChild(script);
    });
  }
  async function initSource(startAt = 0) {
    if (!VIDEO_URL || VIDEO_URL === "PUT_VIDEO_URL_HERE") {
      logError("init", "VIDEO_URL has not been configured");
      showError(true);
      return;
    }
    showLoading(true);
    resumeWhenReady(startAt);
    const type = detectType(VIDEO_URL);
    if (type === "hls") {
      const nativeSupport = video.canPlayType("application/vnd.apple.mpegurl") !== "";
      const canUseHlsJs = !!(window.MediaSource || window.ManagedMediaSource);
      if (canUseHlsJs) {
        try {
          await loadScript(HLS_JS_CDN);
          if (initHlsJs(startAt)) return;
        } catch (err) {
          logError("hls.js load failure", err);
        }
      }
      if (nativeSupport) {
        usingNativeHls = true;
        video.src = VIDEO_URL;
        loadNativeVariants();
      } else {
        logError("hls unsupported", "Neither hls.js nor native HLS is available");
        showError(true);
      }
    } else {
      video.src = VIDEO_URL;
    }
  }
  function initHlsJs(startAt = 0) {
    if (!window.Hls || !window.Hls.isSupported()) {
      logError("hls.js", "Hls.isSupported() returned false");
      return false;
    }
    isHlsJs = true;
    networkRecoveryAttempts = 0;
    mediaRecoveryAttempts = 0;
    const instance = hls = new window.Hls({
      maxBufferLength: 30,
      backBufferLength: 30,
      enableWorker: true,
      capLevelToPlayerSize: false,
      startPosition: startAt > 0 ? startAt : -1
    });
    const isCurrent = () => hls === instance;
    instance.loadSource(VIDEO_URL);
    instance.attachMedia(video);
    instance.on(window.Hls.Events.MANIFEST_PARSED, (event, data) => {
      if (!isCurrent()) return;
      debugLogLevels(instance.levels);
      buildQualityMenu(instance.levels);
      showLoading(false);
    });
    instance.on(window.Hls.Events.LEVEL_SWITCHED, (event, data) => {
      if (isCurrent()) syncQualityUIFromActiveLevel(data.level);
    });
    instance.on(window.Hls.Events.FRAG_LOADED, () => {
      networkRecoveryAttempts = 0;
    });
    instance.on(window.Hls.Events.ERROR, (event, data) => {
      if (!isCurrent()) return;
      if (!data.fatal) {
        logError("hls.js non-fatal", data);
        return;
      }
      logError("hls.js fatal", data);
      switch (data.type) {
       case window.Hls.ErrorTypes.NETWORK_ERROR:
        if (MANIFEST_ERROR_DETAILS.includes(data.details) || networkRecoveryAttempts >= MAX_NETWORK_RECOVERY_ATTEMPTS || navigator.onLine === false) {
          handleFatalError("hls.js network", data);
        } else {
          networkRecoveryAttempts++;
          setTimeout(() => {
            if (isCurrent()) instance.startLoad();
          }, 1e3 * networkRecoveryAttempts);
        }
        break;

       case window.Hls.ErrorTypes.MEDIA_ERROR:
        mediaRecoveryAttempts++;
        if (mediaRecoveryAttempts === 1) {
          instance.recoverMediaError();
        } else if (mediaRecoveryAttempts === 2) {
          instance.swapAudioCodec();
          instance.recoverMediaError();
        } else {
          handleFatalError("hls.js media", data);
        }
        break;

       default:
        handleFatalError("hls.js", data);
        break;
      }
    });
    return true;
  }
  function resumeWhenReady(startAt) {
    video.addEventListener("loadedmetadata", () => {
      if (startAt > 0 && Math.abs(video.currentTime - startAt) > 1 && startAt < (video.duration || Infinity)) {
        try {
          video.currentTime = startAt;
        } catch (err) {
          logError("restore position", err);
        }
      }
    }, {
      once: true
    });
  }
  function handleFatalError(context, err) {
    logError(context, err);
    showError(true);
  }
  function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map(l => l.trim());
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const attrs = lines[i].slice(18);
      const uri = lines.slice(i + 1).find(l => l && !l.startsWith("#"));
      if (!uri) continue;
      const res = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
      const bw = /(?:^|,)BANDWIDTH=(\d+)/i.exec(attrs);
      variants.push({
        url: new URL(uri, baseUrl).href,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        bitrate: bw ? Number(bw[1]) : 0
      });
    }
    return variants;
  }
  async function loadNativeVariants() {
    try {
      const res = await fetch(VIDEO_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/i.test(text)) return;
      nativeVariants = parseMasterPlaylist(text, res.url);
      buildQualityMenu(nativeVariants);
    } catch (err) {
      logError("native quality levels", err);
    }
  }
  function switchNativeSource(url) {
    const time = video.currentTime;
    const wasPlaying = !video.paused;
    const rate = video.playbackRate;
    video.src = url;
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = time;
      video.playbackRate = rate;
      if (wasPlaying) video.play().catch(err => logError("play() after quality switch", err));
    }, {
      once: true
    });
  }
  function syncNativeAutoLabel() {
    if (!usingNativeHls || selectedQualityMode !== "auto" || qualityMenuItem.hidden) return;
    qualityValueLabel.textContent = video.videoHeight ? `Auto (${video.videoHeight}p)` : "Auto";
  }
  let levelIndexToDisplayIndex = {};
  let selectedQualityMode = "auto";
  function levelLabel(level) {
    if (level && level.height) return `${level.height}p`;
    if (level && level.width) return `${level.width}w`;
    if (level && level.bitrate) return `${Math.round(level.bitrate / 1e3)} kbps`;
    return "Unknown";
  }
  function debugLogLevels(levels) {
    console.log("HLS levels:", levels);
    levels.forEach((level, index) => {
      console.log({
        index: index,
        width: level.width,
        height: level.height,
        bitrate: level.bitrate,
        name: level.name,
        url: level.url
      });
    });
    console.log(`Detected HLS quality levels: ${levels.length}`);
    levels.forEach((level, index) => {
      console.log(`  Level ${index}: ${levelLabel(level)} (${level.width || "?"}x${level.height || "?"}, ${level.bitrate ? Math.round(level.bitrate / 1e3) + " kbps" : "bitrate unknown"})`);
    });
  }
  function buildQualityMenu(levels) {
    selectedQualityMode = "auto";
    levelIndexToDisplayIndex = {};
    if (!(isHlsJs || usingNativeHls) || !levels || levels.length <= 1) {
      qualityMenuItem.hidden = true;
      return;
    }
    const seenKeys = new Set;
    const entries = [];
    levels.forEach((level, index) => {
      const height = level.height || 0;
      const width = level.width || 0;
      const bitrate = level.bitrate || 0;
      const key = height ? `h${height}` : width ? `w${width}` : `b${bitrate}`;
      if (seenKeys.has(key)) {
        const owner = entries.find(e => e.key === key);
        if (owner) levelIndexToDisplayIndex[index] = owner.index;
        return;
      }
      seenKeys.add(key);
      entries.push({
        index: index,
        key: key,
        height: height,
        width: width,
        bitrate: bitrate,
        label: levelLabel(level)
      });
      levelIndexToDisplayIndex[index] = index;
    });
    entries.sort((a, b) => {
      if (b.height !== a.height) return b.height - a.height;
      if (b.width !== a.width) return b.width - a.width;
      return b.bitrate - a.bitrate;
    });
    qualityOptions.innerHTML = "";
    qualityOptions.appendChild(makeQualityOption("Auto", "auto", true));
    entries.forEach(entry => {
      qualityOptions.appendChild(makeQualityOption(entry.label, entry.index, false));
    });
    qualityMenuItem.hidden = false;
    currentQualityLabel = "Auto";
    qualityValueLabel.textContent = "Auto";
  }
  function makeQualityOption(label, mode, isSelected) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-menu__option" + (isSelected ? " is-selected" : "");
    btn.setAttribute("role", "menuitemradio");
    btn.setAttribute("aria-checked", String(isSelected));
    btn.dataset.mode = String(mode);
    btn.innerHTML = `<span>${label}</span><svg class="checkmark" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`;
    btn.addEventListener("click", () => selectQuality(mode, label));
    return btn;
  }
  function selectQuality(mode, label) {
    if (usingNativeHls) {
      selectedQualityMode = mode === "auto" ? "auto" : Number(mode);
      switchNativeSource(mode === "auto" ? VIDEO_URL : nativeVariants[Number(mode)].url);
      currentQualityLabel = label;
      qualityValueLabel.textContent = label;
      highlightQualityOption(mode);
      closeSettingsMenu();
      return;
    }
    if (!hls) return;
    if (mode === "auto") {
      hls.currentLevel = -1;
      selectedQualityMode = "auto";
    } else {
      const levelIndex = Number(mode);
      hls.currentLevel = levelIndex;
      selectedQualityMode = levelIndex;
    }
    currentQualityLabel = label;
    qualityValueLabel.textContent = label;
    highlightQualityOption(mode);
    if (mode === "auto") syncQualityUIFromActiveLevel(hls.currentLevel);
    closeSettingsMenu();
  }
  function highlightQualityOption(mode) {
    Array.from(qualityOptions.children).forEach(child => {
      const selected = child.dataset.mode === String(mode);
      child.classList.toggle("is-selected", selected);
      child.setAttribute("aria-checked", String(selected));
    });
  }
  function syncQualityUIFromActiveLevel(activeLevelIndex) {
    if (!hls || qualityMenuItem.hidden) return;
    if (selectedQualityMode === "auto") {
      const activeLevel = hls.levels[activeLevelIndex];
      qualityValueLabel.textContent = activeLevel ? `Auto (${levelLabel(activeLevel)})` : "Auto";
      highlightQualityOption("auto");
      return;
    }
    const displayIndex = levelIndexToDisplayIndex[activeLevelIndex];
    if (displayIndex === undefined) return;
    highlightQualityOption(displayIndex);
  }
  function buildSpeedMenu() {
    speedOptions.innerHTML = "";
    SPEEDS.forEach(speed => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-menu__option" + (speed === 1 ? " is-selected" : "");
      btn.setAttribute("role", "menuitemradio");
      btn.setAttribute("aria-checked", String(speed === 1));
      btn.dataset.speed = String(speed);
      const label = speed === 1 ? "Normal" : `${speed}x`;
      btn.innerHTML = `<span>${label}</span><svg class="checkmark" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`;
      btn.addEventListener("click", () => {
        video.playbackRate = speed;
        speedValueLabel.textContent = label;
        Array.from(speedOptions.children).forEach(child => {
          const selected = child === btn;
          child.classList.toggle("is-selected", selected);
          child.setAttribute("aria-checked", String(selected));
        });
        closeSettingsMenu();
      });
      speedOptions.appendChild(btn);
    });
  }
  function openSettingsMenu() {
    settingsMenu.hidden = false;
    settingsBackdrop.hidden = false;
    settingsBtn.setAttribute("aria-expanded", "true");
    showSettingsPanel("root");
    clearControlsTimeout();
  }
  function closeSettingsMenu() {
    settingsMenu.hidden = true;
    settingsBackdrop.hidden = true;
    settingsBtn.setAttribute("aria-expanded", "false");
    scheduleHideControls();
  }
  function toggleSettingsMenu() {
    if (settingsMenu.hidden) openSettingsMenu(); else closeSettingsMenu();
  }
  function showSettingsPanel(name) {
    Array.from(settingsMenu.querySelectorAll(".settings-menu__panel")).forEach(panel => {
      panel.hidden = panel.dataset.panel !== name;
    });
  }
  settingsMenu.addEventListener("click", e => {
    const target = e.target.closest("[data-target]");
    if (target) {
      showSettingsPanel(target.dataset.target);
      return;
    }
    const back = e.target.closest("[data-back]");
    if (back) {
      showSettingsPanel("root");
    }
  });
  function togglePlay() {
    if (video.paused || video.ended) {
      video.play().catch(err => logError("play() rejected", err));
    } else {
      video.pause();
    }
  }
  function updatePlayPauseUI() {
    const isPaused = video.paused || video.ended;
    [ playPauseBtn, bigPlayBtn ].forEach(btn => {
      setIconHidden(btn.querySelector(".icon-play"), !isPaused);
      setIconHidden(btn.querySelector(".icon-pause"), isPaused);
      btn.setAttribute("aria-label", isPaused ? "Play" : "Pause");
    });
    player.classList.toggle("is-paused", isPaused);
  }
  function updateProgress() {
    if (isScrubbing) return;
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) return;
    const ratio = clamp(video.currentTime / duration, 0, 1);
    playedFill.style.width = ratio * 100 + "%";
    progressHandle.style.left = ratio * 100 + "%";
    progressBar.setAttribute("aria-valuenow", Math.round(ratio * 100));
    currentTimeEl.textContent = formatTime(video.currentTime);
    updateBuffered();
  }
  function updateBuffered() {
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0 || video.buffered.length === 0) return;
    try {
      const end = video.buffered.end(video.buffered.length - 1);
      const ratio = clamp(end / duration, 0, 1);
      bufferedFill.style.width = ratio * 100 + "%";
    } catch (err) {}
  }
  function axisPosition(el, point) {
    const rect = el.getBoundingClientRect();
    if (isRotated()) return {
      pos: point.clientY - rect.top,
      size: rect.height
    };
    return {
      pos: point.clientX - rect.left,
      size: rect.width
    };
  }
  function axisRatio(el, point) {
    const {pos: pos, size: size} = axisPosition(el, point);
    return clamp(pos / size, 0, 1);
  }
  function beginScrub(point) {
    if (!isFinite(video.duration) || video.duration <= 0) return;
    isScrubbing = true;
    wasPlayingBeforeScrub = !video.paused;
    video.pause();
    progressBar.classList.add("is-dragging");
    clearControlsTimeout();
    moveScrub(point);
  }
  function moveScrub(point) {
    if (!isFinite(video.duration) || video.duration <= 0) return;
    const ratio = axisRatio(progressBar, point);
    playedFill.style.width = ratio * 100 + "%";
    progressHandle.style.left = ratio * 100 + "%";
    currentTimeEl.textContent = formatTime(ratio * video.duration);
    progressBar.setAttribute("aria-valuenow", Math.round(ratio * 100));
    updateHoverPreview(point);
  }
  function endScrub(point) {
    if (!isScrubbing) return;
    if (isFinite(video.duration) && video.duration > 0) {
      const ratio = axisRatio(progressBar, point);
      video.currentTime = ratio * video.duration;
    }
    isScrubbing = false;
    progressBar.classList.remove("is-dragging");
    hideHoverPreview();
    if (wasPlayingBeforeScrub) {
      video.play().catch(() => {});
    }
    scheduleHideControls();
  }
  function updateHoverPreview(point) {
    if (!isFinite(video.duration) || video.duration <= 0) return;
    const {pos: pos, size: size} = axisPosition(progressBar, point);
    const ratio = clamp(pos / size, 0, 1);
    hoverFill.style.width = ratio * 100 + "%";
    const edge = hoverTime.offsetWidth / 2;
    hoverTime.style.left = clamp(pos, edge, size - edge) + "px";
    hoverTime.textContent = formatTime(ratio * video.duration);
    hoverTime.classList.add("is-visible");
  }
  function hideHoverPreview() {
    hoverTime.classList.remove("is-visible");
    hoverFill.style.width = "0%";
  }
  progressBar.addEventListener("mousedown", e => {
    beginScrub(e);
    const onMove = ev => moveScrub(ev);
    const onUp = ev => {
      endScrub(ev);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  progressBar.addEventListener("mousemove", e => {
    if (!isScrubbing) updateHoverPreview(e);
  });
  progressBar.addEventListener("mouseleave", () => {
    if (!isScrubbing) hideHoverPreview();
  });
  progressBar.addEventListener("touchstart", e => {
    beginScrub(e.touches[0]);
  }, {
    passive: true
  });
  progressBar.addEventListener("touchmove", e => {
    moveScrub(e.touches[0]);
  }, {
    passive: true
  });
  progressBar.addEventListener("touchend", e => {
    endScrub(e.changedTouches[0]);
    hideHoverPreview();
  });
  progressBar.addEventListener("keydown", e => {
    if (!isFinite(video.duration)) return;
    if (e.key === "ArrowRight") {
      video.currentTime = clamp(video.currentTime + 5, 0, video.duration);
    } else if (e.key === "ArrowLeft") {
      video.currentTime = clamp(video.currentTime - 5, 0, video.duration);
    }
  });
  function updateVolumeUI() {
    const vol = video.muted ? 0 : video.volume;
    volumeFill.style.width = vol * 100 + "%";
    volumeHandle.style.left = vol * 100 + "%";
    volumeSlider.setAttribute("aria-valuenow", Math.round(vol * 100));
    muteBtn.dataset.level = vol === 0 ? "muted" : vol < .5 ? "low" : "high";
    muteBtn.setAttribute("aria-label", vol === 0 ? "Unmute" : "Mute");
  }
  function setVolumeFromPoint(point) {
    const ratio = axisRatio(volumeSlider, point);
    video.volume = ratio;
    video.muted = ratio === 0;
    if (ratio > 0) lastVolume = ratio;
    updateVolumeUI();
  }
  volumeSlider.addEventListener("mousedown", e => {
    isVolumeDragging = true;
    volumeGroup.classList.add("is-dragging");
    setVolumeFromPoint(e);
    const onMove = ev => setVolumeFromPoint(ev);
    const onUp = () => {
      isVolumeDragging = false;
      volumeGroup.classList.remove("is-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  volumeSlider.addEventListener("touchstart", e => {
    volumeGroup.classList.add("is-dragging");
    setVolumeFromPoint(e.touches[0]);
  }, {
    passive: true
  });
  volumeSlider.addEventListener("touchmove", e => {
    setVolumeFromPoint(e.touches[0]);
  }, {
    passive: true
  });
  volumeSlider.addEventListener("touchend", () => {
    volumeGroup.classList.remove("is-dragging");
  });
  volumeSlider.addEventListener("keydown", e => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      video.volume = clamp(video.volume + .1, 0, 1);
      video.muted = false;
      updateVolumeUI();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      video.volume = clamp(video.volume - .1, 0, 1);
      updateVolumeUI();
    }
  });
  muteBtn.addEventListener("click", () => {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      video.volume = lastVolume > 0 ? lastVolume : 1;
    } else {
      lastVolume = video.volume;
      video.muted = true;
    }
    updateVolumeUI();
  });
  if (isTouchDevice) {
    muteBtn.addEventListener("touchend", () => {
      volumeGroup.classList.toggle("is-touch");
    }, {
      passive: true
    });
  }
  const portraitQuery = matchMedia("(orientation: portrait)");
  let isPseudoFullscreen = false;
  function canUseElementFullscreen() {
    return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }
  function isRotated() {
    return player.classList.contains("is-rotated") && portraitQuery.matches;
  }
  function syncRotation() {
    const isWide = !video.videoHeight || video.videoWidth >= video.videoHeight;
    player.classList.toggle("is-rotated", isPseudoFullscreen && isWide);
  }
  function setPseudoFullscreen(on) {
    isPseudoFullscreen = on;
    player.classList.toggle("is-pseudo-fullscreen", on);
    syncRotation();
    updateFullscreenUI();
  }
  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function isFullscreen() {
    return isPseudoFullscreen || !!getFullscreenElement() || !!video.webkitDisplayingFullscreen;
  }
  function enterFullscreen() {
    if (!canUseElementFullscreen()) {
      setPseudoFullscreen(true);
    } else if (player.requestFullscreen) {
      player.requestFullscreen({
        navigationUI: "hide"
      }).then(lockLandscapeForWideVideo).catch(err => logError("requestFullscreen", err));
    } else if (player.webkitRequestFullscreen) {
      player.webkitRequestFullscreen();
    }
  }
  function exitFullscreen() {
    if (isPseudoFullscreen) {
      setPseudoFullscreen(false);
    } else if (getFullscreenElement()) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(err => logError("exitFullscreen", err));
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } else if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) {
      video.webkitExitFullscreen();
    }
  }
  function toggleFullscreen() {
    if (isFullscreen()) exitFullscreen(); else enterFullscreen();
  }
  function lockLandscapeForWideVideo() {
    if (!isTouchDevice || video.videoWidth <= video.videoHeight) return;
    const orientation = screen.orientation;
    if (orientation && typeof orientation.lock === "function") {
      orientation.lock("landscape").catch(() => {});
    }
  }
  function unlockOrientation() {
    const orientation = screen.orientation;
    if (orientation && typeof orientation.unlock === "function") {
      try {
        orientation.unlock();
      } catch (err) {}
    }
  }
  function updateFullscreenUI() {
    const enterIcon = fullscreenBtn.querySelector(".icon-fs-enter");
    const exitIcon = fullscreenBtn.querySelector(".icon-fs-exit");
    const fs = isFullscreen();
    setIconHidden(enterIcon, fs);
    setIconHidden(exitIcon, !fs);
    fullscreenBtn.setAttribute("aria-label", fs ? "Exit fullscreen" : "Fullscreen");
    player.classList.toggle("is-fullscreen", fs);
    if (!fs) unlockOrientation();
  }
  [ "fullscreenchange", "webkitfullscreenchange" ].forEach(evt => {
    document.addEventListener(evt, updateFullscreenUI);
  });
  [ "webkitbeginfullscreen", "webkitendfullscreen" ].forEach(evt => {
    video.addEventListener(evt, updateFullscreenUI);
  });
  [ "loadedmetadata", "resize" ].forEach(evt => {
    video.addEventListener(evt, syncRotation);
  });
  function supportsPip() {
    return document.pictureInPictureEnabled && !video.disablePictureInPicture;
  }
  if (supportsPip()) {
    pipBtn.hidden = false;
    pipBtn.addEventListener("click", async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        logError("pip toggle", err);
      }
    });
  } else if (video.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === "function") {
    pipBtn.hidden = false;
    pipBtn.addEventListener("click", () => {
      const mode = video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture";
      video.webkitSetPresentationMode(mode);
    });
  }
  function clearControlsTimeout() {
    if (controlsTimeout) {
      clearTimeout(controlsTimeout);
      controlsTimeout = null;
    }
  }
  function showControls() {
    player.classList.remove("controls-hidden");
    scheduleHideControls();
  }
  function scheduleHideControls() {
    clearControlsTimeout();
    if (video.paused) return;
    controlsTimeout = setTimeout(() => {
      if (!settingsMenu.hidden) return;
      if (isScrubbing || isVolumeDragging) return;
      player.classList.add("controls-hidden");
    }, hideDelay);
  }
  function hideControls() {
    clearControlsTimeout();
    player.classList.add("controls-hidden");
  }
  function isFromRecentTouch() {
    return Date.now() - lastTouchEndTime < 800;
  }
  player.addEventListener("touchend", () => {
    lastTouchEndTime = Date.now();
  }, {
    passive: true,
    capture: true
  });
  player.addEventListener("mousemove", () => {
    if (!isFromRecentTouch()) showControls();
  });
  player.addEventListener("mouseleave", () => {
    if (!video.paused) scheduleHideControls();
  });
  player.addEventListener("touchstart", e => {
    if (!gestureLayer.contains(e.target)) showControls();
  }, {
    passive: true
  });
  player.addEventListener("keydown", showControls);
  function flashSeek(el, seconds) {
    el._total = el.classList.contains("is-active") ? (el._total || 0) + seconds : seconds;
    el.querySelector(".seek-flash__label").textContent = `${el._total} seconds`;
    el.classList.remove("is-active");
    void el.offsetWidth;
    el.classList.add("is-active");
    clearTimeout(el._flashTimeout);
    el._flashTimeout = setTimeout(() => el.classList.remove("is-active"), 700);
  }
  function seekBy(delta) {
    if (!isFinite(video.duration)) return;
    video.currentTime = clamp(video.currentTime + delta, 0, video.duration);
  }
  gestureLayer.addEventListener("click", e => {
    if (isFromRecentTouch()) return;
    togglePlay();
    showControls();
  });
  gestureLayer.addEventListener("dblclick", () => {
    if (isFromRecentTouch()) return;
    toggleFullscreen();
  });
  const DOUBLE_TAP_MS = 300;
  let lastTapTime = 0;
  let lastTapX = 0;
  let seekChainUntil = 0;
  let seekChainSide = null;
  function tapSeek(isRightSide) {
    const delta = isRightSide ? 10 : -10;
    seekBy(delta);
    flashSeek(isRightSide ? seekFlashRight : seekFlashLeft, 10);
    hideControls();
  }
  gestureLayer.addEventListener("touchend", e => {
    const touch = e.changedTouches[0];
    const now = Date.now();
    const {pos: pos, size: size} = axisPosition(gestureLayer, touch);
    const isRightSide = pos > size / 2;
    const side = isRightSide ? "right" : "left";
    if (now < seekChainUntil && side === seekChainSide) {
      tapSeek(isRightSide);
      seekChainUntil = now + 700;
      return;
    }
    if (now - lastTapTime < DOUBLE_TAP_MS && Math.abs(pos - lastTapX) < 60) {
      clearTimeout(tapTimer);
      lastTapTime = 0;
      tapSeek(isRightSide);
      seekChainSide = side;
      seekChainUntil = now + 700;
      return;
    }
    seekChainUntil = 0;
    lastTapTime = now;
    lastTapX = pos;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      if (player.classList.contains("controls-hidden")) showControls(); else hideControls();
    }, DOUBLE_TAP_MS);
  }, {
    passive: true
  });
  seekBackBtn.addEventListener("click", () => {
    seekBy(-10);
    showControls();
  });
  seekFwdBtn.addEventListener("click", () => {
    seekBy(10);
    showControls();
  });
  document.addEventListener("keydown", e => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    switch (e.key) {
     case " ":
     case "k":
     case "K":
      e.preventDefault();
      togglePlay();
      showControls();
      break;

     case "ArrowRight":
      if (document.activeElement !== progressBar) {
        seekBy(10);
        showControls();
      }
      break;

     case "ArrowLeft":
      if (document.activeElement !== progressBar) {
        seekBy(-10);
        showControls();
      }
      break;

     case "ArrowUp":
      if (document.activeElement !== volumeSlider) {
        e.preventDefault();
        video.volume = clamp(video.volume + .1, 0, 1);
        video.muted = false;
        updateVolumeUI();
        showControls();
      }
      break;

     case "ArrowDown":
      if (document.activeElement !== volumeSlider) {
        e.preventDefault();
        video.volume = clamp(video.volume - .1, 0, 1);
        updateVolumeUI();
        showControls();
      }
      break;

     case "m":
     case "M":
      muteBtn.click();
      break;

     case "f":
     case "F":
      toggleFullscreen();
      break;

     case "Escape":
      if (isFullscreen()) exitFullscreen();
      break;
    }
  });
  video.addEventListener("loadstart", () => showLoading(true));
  video.addEventListener("waiting", () => showBuffering(true));
  video.addEventListener("playing", () => {
    showBuffering(false);
    showLoading(false);
  });
  video.addEventListener("canplay", () => {
    showLoading(false);
    if (video.paused) showBuffering(false);
  });
  video.addEventListener("loadedmetadata", () => {
    durationEl.textContent = formatTime(video.duration);
    updateVolumeUI();
  });
  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("progress", updateBuffered);
  video.addEventListener("durationchange", () => {
    durationEl.textContent = formatTime(video.duration);
  });
  video.addEventListener("play", () => {
    player.classList.add("has-started");
    updatePlayPauseUI();
    scheduleHideControls();
  });
  video.addEventListener("pause", () => {
    showBuffering(false);
    updatePlayPauseUI();
    clearControlsTimeout();
    player.classList.remove("controls-hidden");
  });
  video.addEventListener("ended", () => {
    showBuffering(false);
    updatePlayPauseUI();
    player.classList.remove("controls-hidden");
    clearControlsTimeout();
  });
  video.addEventListener("error", () => {
    if (isHlsJs || !video.error || video.error.code === 1 || !video.currentSrc) return;
    handleFatalError("video element error", video.error);
  });
  let lastSavedAt = 0;
  function savePosition() {
    try {
      if (lastKnownTime > 0) {
        sessionStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify({
          src: VIDEO_URL.split("?")[0],
          time: lastKnownTime
        }));
      } else {
        sessionStorage.removeItem(RESUME_STORAGE_KEY);
      }
    } catch (err) {}
  }
  function loadSavedPosition() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(RESUME_STORAGE_KEY) || "null");
      if (saved && saved.src === VIDEO_URL.split("?")[0] && saved.time > 0) return saved.time;
    } catch (err) {}
    return 0;
  }
  video.addEventListener("timeupdate", () => {
    if (isScrubbing || !errorState.hidden || video.currentTime <= 0) return;
    lastKnownTime = video.currentTime;
    if (Date.now() - lastSavedAt > 5e3) {
      lastSavedAt = Date.now();
      savePosition();
    }
  });
  video.addEventListener("playing", () => {
    mediaRecoveryAttempts = 0;
  });
  video.addEventListener("ended", () => {
    lastKnownTime = 0;
    savePosition();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) savePosition();
  });
  window.addEventListener("pagehide", savePosition);
  [ "playing", "emptied" ].forEach(evt => {
    video.addEventListener(evt, updatePlayPauseUI);
  });
  video.addEventListener("volumechange", updateVolumeUI);
  video.addEventListener("resize", syncNativeAutoLabel);
  bigPlayBtn.addEventListener("click", () => {
    togglePlay();
    showControls();
  });
  playPauseBtn.addEventListener("click", () => {
    togglePlay();
    showControls();
  });
  settingsBtn.addEventListener("click", e => {
    e.stopPropagation();
    toggleSettingsMenu();
  });
  fullscreenBtn.addEventListener("click", () => {
    toggleFullscreen();
    showControls();
  });
  retryBtn.addEventListener("click", () => {
    savePosition();
    location.reload();
  });
  document.addEventListener("click", e => {
    if (!settingsMenu.hidden && !settingsMenu.contains(e.target) && e.target !== settingsBtn) {
      closeSettingsMenu();
    }
  });
  settingsBackdrop.addEventListener("click", e => {
    e.stopPropagation();
    closeSettingsMenu();
  });
  async function init() {
    buildSpeedMenu();
    updatePlayPauseUI();
    updateVolumeUI();
    updateFullscreenUI();
    showControls();
    await loadRemoteVideoUrl();
    lastKnownTime = loadSavedPosition();
    initSource(lastKnownTime);
  }
  init();
})();
