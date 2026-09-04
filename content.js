if (!globalThis.__playtextContentLoaded) {
globalThis.__playtextContentLoaded = true;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseClock(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return 0;
}

function readSegments() {
  const nodes = [
    ...document.querySelectorAll("ytd-transcript-segment-renderer"),
    ...document.querySelectorAll("yt-transcript-segment-renderer"),
  ];
  const seen = new Set();
  const cues = [];
  for (const node of nodes) {
    const text = (
      node.querySelector("#segment-text, .segment-text, yt-formatted-string.segment-text")?.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!text || seen.has(text + node.textContent)) continue;
    seen.add(text + node.textContent);
    const stamp = (
      node.querySelector("#segment-timestamp, .segment-timestamp")?.textContent || ""
    ).trim();
    cues.push({
      startMs: parseClock(stamp),
      durationMs: 2000,
      text,
    });
  }
  for (let i = 0; i < cues.length - 1; i += 1) {
    const next = cues[i + 1].startMs - cues[i].startMs;
    if (next > 0) cues[i].durationMs = next;
  }
  return cues;
}

function clickIfExists(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.click();
  return true;
}

async function openTranscriptPanel() {
  if (readSegments().length) return true;

  clickIfExists("#expand");
  clickIfExists("ytd-text-inline-expander #expand");
  clickIfExists("#description-inline-expander #expand");
  await sleep(350);

  const labeled = document.querySelector(
    'button[aria-label="Show transcript"], button[aria-label*="transcript" i], button[aria-label*="Transcript"]'
  );
  if (labeled) {
    labeled.click();
    return true;
  }

  const buttons = [...document.querySelectorAll("button, yt-button-shape button, ytd-button-renderer button")];
  const show = buttons.find((button) => /show transcript/i.test(button.textContent || button.getAttribute("aria-label") || ""));
  if (show) {
    show.click();
    return true;
  }

  const menu = document.querySelector(
    '#button-shape button[aria-label="More actions"], ytd-menu-renderer.ytd-watch-metadata button[aria-label="More actions"], button[aria-label="More actions"]'
  );
  if (menu) {
    menu.click();
    await sleep(400);
    const items = [
      ...document.querySelectorAll(
        "ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model, ytd-menu-navigation-item-renderer"
      ),
    ];
    const item = items.find((el) => /transcript/i.test(el.textContent || ""));
    if (item) {
      item.click();
      return true;
    }
  }
  return false;
}

async function scrapeTranscript() {
  let cues = readSegments();
  if (cues.length) return cues;
  await openTranscriptPanel();
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    cues = readSegments();
    if (cues.length) return cues;
  }
  return [];
}

function ensureInjected() {
  if (document.getElementById("playtext-inject")) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = "playtext-inject";
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not inject caption helper."));
    (document.head || document.documentElement).appendChild(script);
  });
}

function fetchViaPage(videoId) {
  return new Promise((resolve, reject) => {
    const requestId = `pt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Caption download timed out."));
    }, 18000);
    function onMessage(event) {
      if (event.source !== window) return;
      if (event.data?.source !== "playtext" || event.data?.type !== "RESULT") return;
      if (event.data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error || "Page caption fetch failed."));
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "playtext", type: "FETCH", requestId, videoId }, "*");
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EXTRACT") return;
  (async () => {
    const cues = await scrapeTranscript();
    if (cues.length) {
      return { ok: true, source: "dom", cues };
    }
    await ensureInjected();
    const result = await fetchViaPage(message.videoId);
    return { ok: true, source: "page-fetch", ...result };
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
}
