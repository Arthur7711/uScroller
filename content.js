// uScroller content script — auto-advances YouTube Shorts.
(() => {
  const DEFAULTS = {
    enabled: true,
    mode: "end",        // "end" = when the short finishes, "interval" = every N seconds
    interval: 15,       // seconds, used in "interval" mode
    delay: 0.5,         // seconds to wait after a short ends before scrolling
    skipAds: true,      // immediately skip sponsored shorts
    scrolled: 0         // counter shown in the popup
  };

  const log = (...a) => console.log("%c[uScroller]", "color:#ff0033;font-weight:bold", ...a);

  let settings = { ...DEFAULTS };
  let currentVideo = null;
  let currentUrl = location.href;
  let startedAt = Date.now();
  let lastTime = 0;
  let busy = false;          // true while waiting for delay / navigation

  const isShortsPage = () => location.pathname.startsWith("/shorts/");

  // ---------- settings (guarded: extension reload invalidates old scripts) ----------
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const store = (obj) => { if (alive()) try { chrome.storage.sync.set(obj); } catch {} };

  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    log("loaded, settings:", settings);
  });
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    resetTimer();
  });

  // ---------- helpers ----------
  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  function getActiveVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const a = visibleArea(v);
      if (a > bestArea && v.readyState > 0) { best = v; bestArea = a; }
    }
    return best;
  }

  function getActiveRenderer() {
    const v = getActiveVideo();
    return (
      v?.closest("ytd-reel-video-renderer") ||
      document.querySelector("ytd-reel-video-renderer[is-active]") ||
      null
    );
  }

  function isAd() {
    const r = getActiveRenderer();
    if (!r) return false; // don't guess — avoids false positives from ads elsewhere on the page
    return !!r.querySelector("ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ad-badge-view-model");
  }

  function resetTimer() {
    startedAt = Date.now();
    lastTime = 0;
  }

  // ---------- navigation strategies (tried in order until the URL changes) ----------
  const strategies = [
    function clickNextButton() {
      const btns = [
        ...document.querySelectorAll(
          "#navigation-button-down button, #navigation-button-down [role=button], " +
          "button[aria-label='Next video'], button[aria-label*='Next']"
        )
      ].filter((b) => b.offsetParent !== null && !b.disabled);
      if (!btns.length) return false;
      btns[0].click();
      return true;
    },
    function scrollToNextRenderer() {
      const cur = getActiveRenderer();
      let next = cur?.nextElementSibling;
      while (next && next.tagName !== "YTD-REEL-VIDEO-RENDERER") next = next.nextElementSibling;
      if (!next) return false;
      next.scrollIntoView({ behavior: "smooth", block: "start" });
      return true;
    },
    function scrollContainer() {
      const c =
        document.querySelector("#shorts-inner-container") ||
        document.querySelector("ytd-shorts #shorts-container");
      if (!c) return false;
      c.scrollBy({ top: c.clientHeight || innerHeight, behavior: "smooth" });
      return true;
    },
    function pressArrowDown() {
      const opts = { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true };
      for (const t of [document.activeElement, document.body, document]) {
        if (!t) continue;
        t.dispatchEvent(new KeyboardEvent("keydown", opts));
        t.dispatchEvent(new KeyboardEvent("keyup", opts));
      }
      return true;
    },
    function wheelDown() {
      const target = getActiveRenderer() || getActiveVideo() || document.body;
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
      return true;
    }
  ];

  async function goNext(reason) {
    if (busy) return;
    busy = true;
    const startUrl = location.href;
    const startVideoSrc = getActiveVideo()?.currentSrc;
    log("advancing:", reason);

    for (const s of strategies) {
      let ran = false;
      try { ran = s(); } catch (e) { log(s.name, "threw", e); }
      if (!ran) { log(s.name, "→ not applicable"); continue; }

      // wait up to 1.5s for the short to change
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (location.href !== startUrl || getActiveVideo()?.currentSrc !== startVideoSrc) {
          log(s.name, "→ success");
          settings.scrolled = (settings.scrolled || 0) + 1;
          store({ scrolled: settings.scrolled });
          currentUrl = location.href;
          resetTimer();
          setTimeout(() => { busy = false; }, 800);
          return;
        }
      }
      log(s.name, "→ no change, trying next method");
    }

    log("all methods failed — please report the log above");
    resetTimer();
    setTimeout(() => { busy = false; }, 2000);
  }

  function scheduleNext(reason) {
    if (busy) return;
    busy = true;
    setTimeout(() => {
      busy = false;
      if (settings.enabled && isShortsPage()) goNext(reason);
    }, Math.max(0, settings.delay * 1000));
  }

  // ---------- main loop ----------
  setInterval(() => {
    if (!alive()) return;
    if (!settings.enabled || !isShortsPage()) return;

    if (location.href !== currentUrl) {
      currentUrl = location.href;
      resetTimer();
    }

    const video = getActiveVideo();
    if (video !== currentVideo) {
      currentVideo = video;
      resetTimer();
      if (video) video.addEventListener("ended", () => scheduleNext("ended event"));
    }
    if (!video || busy) return;

    if (settings.skipAds && isAd()) return goNext("ad");

    if (settings.mode === "interval") {
      if (Date.now() - startedAt >= settings.interval * 1000) goNext("interval");
      return;
    }

    // Shorts loop, so "ended" usually never fires — detect the playhead
    // reaching the end, or jumping back to the start (a loop).
    const t = video.currentTime;
    const d = video.duration;
    const nearEnd = d && isFinite(d) && d > 1 && t >= d - 0.4;
    const looped = lastTime > 1 && t < lastTime - 1 && !video.seeking;
    lastTime = t;

    if (nearEnd) scheduleNext("near end");
    else if (looped) scheduleNext("looped");
  }, 200);

  // Keyboard shortcut: Alt+S toggles the bot on/off.
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyS") {
      store({ enabled: !settings.enabled });
      toast(`uScroller ${!settings.enabled ? "ON" : "OFF"}`);
    }
  });

  function toast(text) {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed", top: "70px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(0,0,0,.8)", color: "#fff", padding: "8px 16px",
      borderRadius: "8px", font: "600 14px Roboto, Arial, sans-serif", zIndex: 99999
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // Debug helper: from the page console run
  //   window.dispatchEvent(new Event("uscroller-next"))
  // to force one scroll attempt and see which method works.
  window.addEventListener("uscroller-next", () => goNext("manual test"));
  log("content script injected on", location.href);
})();
