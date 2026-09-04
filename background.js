import {
  buildCaptionUrl,
  collectTracks,
  dedupeCues,
  extractPlayerResponse,
  extractVideoId,
  parseCaptionPayload,
  rankTracks,
  toParagraphs,
  toPlainText,
  toSrt,
  videoMeta,
} from "./shared.js";

const INNERTUBE_CLIENTS = [
  { clientName: "ANDROID", clientVersion: "20.10.38" },
  { clientName: "IOS", clientVersion: "20.10.38" },
  { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0" },
  { clientName: "WEB", clientVersion: "2.20250323.01.00" },
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || "Something went wrong." });
    });
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "generate-transcript") return;
  await chrome.action.openPopup();
});

async function handleMessage(message) {
  if (message?.type === "GET_ACTIVE_TAB") {
    const tab = await getActiveTab();
    const videoId = extractVideoId(tab?.url || "");
    return {
      ok: true,
      tab: {
        url: tab?.url || "",
        title: tab?.title || "",
        videoId,
      },
    };
  }

  if (message?.type === "GENERATE_TRANSCRIPT") {
    const videoId = extractVideoId(message.input);
    if (!videoId) {
      return { ok: false, error: "That doesn’t look like a YouTube video link." };
    }
    const result = await generateTranscript(
      videoId,
      message.lang || "en",
      message.trackUrl || null
    );
    await chrome.storage.local.set({ lastTranscript: result });
    return { ok: true, result };
  }

  if (message?.type === "GET_LAST") {
    const stored = await chrome.storage.local.get("lastTranscript");
    return { ok: true, result: stored.lastTranscript || null };
  }

  return { ok: false, error: "Unknown request." };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function generateTranscript(videoId, preferredLang, selectedUrl) {
  const tab = await getActiveTab();
  const tabId = extractVideoId(tab?.url || "") === videoId ? tab.id : null;
  const errors = [];

  if (tabId) {
    try {
      const page = await fetchCaptionsInPage(tabId, videoId);
      const built = resultFromPayload(page, videoId, preferredLang, tab);
      if (built) return built;
      if (page?.error) errors.push(page.error);
    } catch (error) {
      errors.push(error.message);
    }
  }

  try {
    const remote = await fetchCaptionsAndroid(videoId, preferredLang, selectedUrl, tab);
    if (remote) return remote;
  } catch (error) {
    errors.push(error.message);
  }

  throw new Error(
    errors.filter(Boolean).slice(0, 2).join(" — ") ||
      "Transcript nahi mil saka. chrome://extensions par Playtext Reload karo, Allow dabao, phir wapas try karo."
  );
}

async function fetchCaptionsInPage(tabId, videoId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (id) => {
      window.__playtextVideoId = id;
      window.__playtextState = { done: false, result: null };
    },
    args: [videoId],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["page-captions.js"],
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => window.__playtextState,
    });
    if (result?.done) return result.result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, error: "YouTube page timed out." };
}

async function fetchCaptionsAndroid(videoId, preferredLang, selectedUrl, tab) {
  const player = await fetchPlayer(videoId);
  const meta = videoMeta(player, videoId);
  if (tab?.title && (!meta.title || meta.title === "YouTube video")) {
    meta.title = String(tab.title).replace(/\s*-\s*YouTube$/, "");
  }
  const tracks = rankTracks(collectTracks(player), preferredLang);
  if (!tracks.length) return null;

  const preferred =
    (selectedUrl && tracks.find((item) => item.baseUrl === selectedUrl)) || tracks[0];
  const ordered = [preferred, ...tracks.filter((item) => item.baseUrl !== preferred.baseUrl)];

  for (const track of ordered) {
    const cues = await fetchCues(track.baseUrl, null);
    if (!cues.length) continue;
    const cleaned = dedupeCues(cues);
    const paragraphs = toParagraphs(cleaned, { language: track.languageCode || preferredLang });
    return {
      meta,
      track,
      tracks,
      cues: cleaned,
      paragraphs,
      text: toPlainText(paragraphs),
      textWithTimestamps: toPlainText(paragraphs, { timestamps: true }),
      srt: toSrt(cleaned),
      generatedAt: Date.now(),
    };
  }
  return null;
}

function resultFromPayload(page, videoId, preferredLang, tab) {
  if (!page) return null;
  const tabTitle = String(tab?.title || "").replace(/\s*-\s*YouTube$/, "");
  const meta = {
    videoId,
    title: page.meta?.title || tabTitle || "YouTube video",
    author: page.meta?.author || "",
    lengthSeconds: 0,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };

  if (page.cues?.length) {
    const cleaned = dedupeCues(page.cues);
    const paragraphs = toParagraphs(cleaned, { language: preferredLang });
    const track = {
      languageName: "YouTube transcript",
      languageCode: (preferredLang || "en").slice(0, 2),
      isAuto: false,
      baseUrl: "page",
    };
    return packResult(meta, track, [track], cleaned, paragraphs);
  }

  if (!page.ok || !page.payload) return null;
  const cues = parseCaptionPayload(page.payload);
  if (!cues.length) return null;
  const cleaned = dedupeCues(cues);
  const tracks = rankTracks(
    (page.tracks || []).map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode || "en",
      languageName:
        track.name?.simpleText ||
        (Array.isArray(track.name?.runs) ? track.name.runs.map((run) => run.text).join("") : "") ||
        track.languageCode ||
        "Captions",
      kind: track.kind || "",
      isAuto: track.kind === "asr",
      vssId: track.vssId || "",
    })),
    preferredLang
  );
  const track = tracks[0] || {
    languageName: "Captions",
    languageCode: "en",
    isAuto: false,
    baseUrl: "",
  };
  const paragraphs = toParagraphs(cleaned, { language: track.languageCode || preferredLang });
  return packResult(meta, track, tracks.length ? tracks : [track], cleaned, paragraphs);
}

function packResult(meta, track, tracks, cleaned, paragraphs) {
  return {
    meta,
    track,
    tracks,
    cues: cleaned,
    paragraphs,
    text: toPlainText(paragraphs),
    textWithTimestamps: toPlainText(paragraphs, { timestamps: true }),
    srt: toSrt(cleaned),
    generatedAt: Date.now(),
  };
}

async function loadPlayer(videoId, tabId) {
  const remote = await fetchPlayer(videoId);
  if (!tabId) return remote;
  try {
    const pagePlayer = await getPagePlayer(tabId);
    if (!pagePlayer) return remote;
    if (collectTracks(remote).length) {
      return {
        ...pagePlayer,
        captions: remote.captions || pagePlayer.captions,
        videoDetails: pagePlayer.videoDetails || remote.videoDetails,
      };
    }
    return collectTracks(pagePlayer).length ? pagePlayer : remote;
  } catch {
    return remote;
  }
}

async function fetchPlayer(videoId) {
  let lastPlayer = null;
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const player = await fetchInnertube(videoId, client);
      lastPlayer = player;
      if (collectTracks(player).length) return player;
    } catch {
      // try next client
    }
  }
  try {
    const htmlPlayer = await fetchFromWatchPage(videoId);
    if (htmlPlayer && collectTracks(htmlPlayer).length) return htmlPlayer;
    if (htmlPlayer) lastPlayer = htmlPlayer;
  } catch {
    // ignore
  }
  if (lastPlayer) return lastPlayer;
  throw new Error("Could not load this YouTube video. It may be private or unavailable.");
}

async function fetchInnertube(videoId, client) {
  const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: JSON.stringify({
      context: {
        client: {
          hl: "en",
          gl: "US",
          ...client,
        },
      },
      videoId,
    }),
  });
  if (!response.ok) throw new Error(`YouTube returned ${response.status}.`);
  return response.json();
}

async function fetchFromWatchPage(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
    credentials: "include",
  });
  const html = await response.text();
  if (/consent\.youtube\.com|Before you continue to YouTube/i.test(html)) {
    throw new Error("YouTube asked for consent in this browser session. Open the video once, then try again.");
  }
  const player = extractPlayerResponse(html);
  if (!player) throw new Error("Could not read caption data from YouTube.");
  return player;
}

async function fetchCues(baseUrl, tabId) {
  const urls = [
    baseUrl,
    buildCaptionUrl(baseUrl, "json3"),
    buildCaptionUrl(baseUrl, "vtt"),
    buildCaptionUrl(baseUrl, "srv3"),
    buildCaptionUrl(baseUrl, "srv1"),
  ];

  for (const url of [...new Set(urls)]) {
    const text = await downloadCaption(url, tabId);
    const cues = parseCaptionPayload(text || "");
    if (cues.length) return cues;
  }

  if (tabId) {
    const captured = await captureTimedtext(tabId);
    for (const url of captured) {
      const text = await downloadCaption(url, tabId);
      const cues = parseCaptionPayload(text || "");
      if (cues.length) return cues;
    }
  }

  throw new Error("Could not download captions (legacy path). Reload Playtext — popup should say v1.5.");
}

async function downloadCaption(url, tabId) {
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (response.ok) {
      const text = await response.text();
      if (text.trim()) return text;
    }
  } catch {
    // try the page next
  }
  if (!tabId) return "";
  try {
    const page = await fetchInPage(tabId, url);
    return page?.text || "";
  } catch {
    return "";
  }
}

async function getPagePlayer(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
      const raw = window.ytplayer?.config?.args?.player_response;
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    },
  });
  return result || null;
}

async function fetchInPage(tabId, url) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (captionUrl) => {
      const response = await fetch(captionUrl, { credentials: "include" });
      return { ok: response.ok, status: response.status, text: await response.text() };
    },
    args: [url],
  });
  return result || { ok: false, text: "" };
}

async function captureTimedtext(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (window.__playtextCapture) return;
      window.__playtextCapture = { urls: [] };
      const originalFetch = window.fetch;
      window.fetch = async function playtextFetch(...args) {
        const target = String(args[0]?.url || args[0] || "");
        if (target.includes("/api/timedtext")) window.__playtextCapture.urls.push(target);
        return originalFetch.apply(this, args);
      };
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function playtextOpen(method, url, ...rest) {
        if (String(url).includes("/api/timedtext")) {
          window.__playtextCapture.urls.push(String(url));
        }
        return originalOpen.call(this, method, url, ...rest);
      };
    },
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const player = document.getElementById("movie_player");
      try {
        player?.toggleSubtitlesOn?.();
      } catch {
        // ignore
      }
      const button = document.querySelector(".ytp-subtitles-button");
      if (button && button.getAttribute("aria-pressed") !== "true") button.click();
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 900));
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => window.__playtextCapture?.urls || [],
  });
  return [...new Set(result || [])];
}
