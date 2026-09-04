import {
  formatClock,
  extractVideoId,
  parseCaptionPayload,
  dedupeCues,
  toParagraphs,
  toPlainText,
  toSrt,
} from "./shared.js";
import { extractYouTubeTranscript } from "./extract-page.js";
import { fetchAndroidTranscript } from "./remote-android.js";

const VERSION = "1.5";

const els = {
  form: document.getElementById("form"),
  url: document.getElementById("url"),
  generate: document.getElementById("generate"),
  hint: document.getElementById("hint"),
  card: document.getElementById("video-card"),
  thumb: document.getElementById("thumb"),
  title: document.getElementById("title"),
  channel: document.getElementById("channel"),
  toolbar: document.getElementById("toolbar"),
  track: document.getElementById("track"),
  timestamps: document.getElementById("timestamps"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  search: document.getElementById("search"),
  transcript: document.getElementById("transcript"),
  copy: document.getElementById("copy"),
  txt: document.getElementById("txt"),
  srt: document.getElementById("srt"),
  expand: document.getElementById("expand"),
};

let current = null;

init();

async function init() {
  const subtitle = document.querySelector(".brand p");
  if (subtitle) subtitle.textContent = "YouTube transcripts · v" + VERSION;

  const stored = await chrome.storage.local.get("lastTranscript");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = extractVideoId(tab?.url || "");
  if (videoId) {
    els.url.value = tab.url;
    showHint("Using the video in this tab.");
  } else if (stored.lastTranscript?.meta?.url) {
    els.url.value = stored.lastTranscript.meta.url;
  }
  if (stored.lastTranscript) {
    const same = videoId && stored.lastTranscript.meta?.videoId === videoId;
    if (same || !videoId) renderResult(stored.lastTranscript);
  }
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await generate();
});

els.timestamps.addEventListener("change", () => {
  if (current) drawTranscript(current);
});

els.search.addEventListener("input", () => {
  if (current) drawTranscript(current);
});

els.copy.addEventListener("click", async () => {
  if (!current) return;
  await navigator.clipboard.writeText(els.timestamps.checked ? current.textWithTimestamps : current.text);
  flash(els.copy, "Copied");
});

els.txt.addEventListener("click", () => saveFile("txt"));
els.srt.addEventListener("click", () => saveFile("srt"));
els.expand.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

async function generate() {
  const input = els.url.value.trim();
  const videoId = extractVideoId(input);
  if (!videoId) {
    setStatus("Paste a YouTube video link first.", "error");
    return;
  }

  els.generate.disabled = true;
  els.generate.textContent = "Generating…";
  setStatus("Working… v" + VERSION);

  const errors = [];
  let page = null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && extractVideoId(tab.url || "") === videoId) {
      setStatus("Reading transcript from the YouTube tab…");
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: extractYouTubeTranscript,
        args: [videoId],
      });
      page = injected?.[0]?.result || null;
      if (page && page.ok === false && page.error) errors.push(page.error);
    } else {
      errors.push("Stay on the YouTube video tab, then click Generate.");
    }
  } catch (error) {
    errors.push(error.message || String(error));
  }

  if (!page?.ok && !page?.cues && !page?.payload) {
    try {
      setStatus("Trying a direct caption download…");
      page = await fetchAndroidTranscript(videoId);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  els.generate.disabled = false;
  els.generate.textContent = "Generate transcript";

  const result = page ? buildResult(page, videoId) : null;
  if (!result) {
    setStatus(
      (errors.filter(Boolean)[0] || "No transcript returned.") +
        " Reload Playtext on chrome://extensions (look for v" +
        VERSION +
        "), click Allow, stay on the video, try again.",
      "error"
    );
    return;
  }

  await chrome.storage.local.set({ lastTranscript: result });
  renderResult(result);
  setStatus("Transcript ready.", "ok");
}

function buildResult(page, videoId) {
  const meta = {
    videoId,
    title: page.meta?.title || "YouTube video",
    author: page.meta?.author || "",
    lengthSeconds: 0,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
  let cues = [];
  if (page.cues?.length) cues = page.cues;
  else if (page.payload) cues = parseCaptionPayload(page.payload);
  if (!cues.length) return null;
  const cleaned = dedupeCues(cues);
  const paragraphs = toParagraphs(cleaned, { language: "en" });
  const track = {
    languageName: "Transcript",
    languageCode: "en",
    isAuto: false,
    baseUrl: "page",
  };
  return {
    meta,
    track,
    tracks: [track],
    cues: cleaned,
    paragraphs,
    text: toPlainText(paragraphs),
    textWithTimestamps: toPlainText(paragraphs, { timestamps: true }),
    srt: toSrt(cleaned),
    generatedAt: Date.now(),
  };
}

function renderResult(result) {
  current = result;
  els.card.classList.remove("hidden");
  els.toolbar.classList.remove("hidden");
  els.result.classList.remove("hidden");
  els.thumb.src = result.meta.thumbnail;
  els.thumb.alt = result.meta.title;
  els.title.textContent = result.meta.title;
  els.channel.textContent = result.meta.author;
  els.track.innerHTML = `<option>${escapeHtml(result.track.languageName)}</option>`;
  drawTranscript(result);
}

function drawTranscript(result) {
  const query = els.search.value.trim();
  const showTime = els.timestamps.checked;
  els.transcript.innerHTML = result.paragraphs
    .map((paragraph) => {
      let text = escapeHtml(paragraph.text);
      if (query) {
        const safe = escapeRegExp(escapeHtml(query));
        text = text.replace(new RegExp(safe, "ig"), (match) => `<mark>${match}</mark>`);
      }
      const time = showTime ? `<time>${formatClock(paragraph.startMs)}</time>` : "";
      return `<p class="p${paragraph.sound ? " sound" : ""}">${time}${text}</p>`;
    })
    .join("");
}

function saveFile(kind) {
  if (!current) return;
  const slug = (current.meta.title || "transcript").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const content = kind === "srt" ? current.srt : els.timestamps.checked ? current.textWithTimestamps : current.text;
  const blob = new Blob([content], { type: kind === "srt" ? "application/x-subrip" : "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug || "transcript"}.${kind}`;
  link.click();
  URL.revokeObjectURL(url);
}

function setStatus(message, kind = "") {
  els.status.classList.remove("hidden", "error", "ok");
  if (kind) els.status.classList.add(kind);
  els.status.textContent = message;
}

function showHint(message) {
  els.hint.classList.remove("hidden");
  els.hint.textContent = message;
}

function flash(button, label) {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
