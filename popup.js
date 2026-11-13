const DEFAULTS = { enabled: true, mode: "end", interval: 15, delay: 0.5, skipAds: true, scrolled: 0 };
const $ = (id) => document.getElementById(id);

function render(s) {
  $("enabled").checked = s.enabled;
  $("mode").value = s.mode;
  $("interval").value = s.interval;
  $("delay").value = s.delay;
  $("skipAds").checked = s.skipAds;
  $("scrolled").textContent = s.scrolled;
  $("intervalRow").classList.toggle("hidden", s.mode !== "interval");
  $("delayRow").classList.toggle("hidden", s.mode !== "end");
}

chrome.storage.sync.get(DEFAULTS, render);
chrome.storage.onChanged.addListener(() => chrome.storage.sync.get(DEFAULTS, render));

$("enabled").onchange = (e) => chrome.storage.sync.set({ enabled: e.target.checked });
$("skipAds").onchange = (e) => chrome.storage.sync.set({ skipAds: e.target.checked });
$("mode").onchange = (e) => chrome.storage.sync.set({ mode: e.target.value });
$("interval").onchange = (e) => chrome.storage.sync.set({ interval: Math.max(1, +e.target.value || 15) });
$("delay").onchange = (e) => chrome.storage.sync.set({ delay: Math.max(0, +e.target.value || 0) });
$("reset").onclick = () => chrome.storage.sync.set({ scrolled: 0 });
