const SOUND_RE =
  /^\[(music|applause|laughter|cheering|silence|inaudible|foreign|singing|crowd)[^\]]*\]$/i;

export function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0] || "";
      return isVideoId(id.slice(0, 11)) ? id.slice(0, 11) : null;
    }

    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtube-nocookie.com"
    ) {
      const fromQuery = url.searchParams.get("v");
      if (isVideoId(fromQuery)) return fromQuery;

      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live", "v", "e"].includes(parts[0]) && isVideoId(parts[1])) {
        return parts[1].slice(0, 11);
      }
    }
  } catch {
    // fall through to regex
  }

  const match = trimmed.match(
    /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/|live\/|v\/|e\/)|[?&]v=)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function isVideoId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value);
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function extractJsonObject(source, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function extractPlayerResponse(html) {
  const markers = ["ytInitialPlayerResponse = ", "ytInitialPlayerResponse="];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const start = idx + marker.length;
    if (html[start] !== "{") continue;
    const json = extractJsonObject(html, start);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      continue;
    }
  }
  return null;
}

function captionLabel(track) {
  const named =
    track.name?.simpleText ||
    (Array.isArray(track.name?.runs) ? track.name.runs.map((run) => run.text).join("") : "");
  if (named) return named;
  const code = (track.languageCode || "").slice(0, 2);
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || track.languageCode || "Unknown";
  } catch {
    return track.languageCode || "Unknown";
  }
}

export function collectTracks(player) {
  const tracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return tracks
    .filter((track) => track?.baseUrl)
    .map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode || "und",
      languageName: captionLabel(track),
      kind: track.kind || "",
      isAuto: track.kind === "asr" || String(track.vssId || "").startsWith("a."),
      vssId: track.vssId || "",
    }));
}

export function rankTracks(tracks, preferredLang = "en") {
  const pref = preferredLang.slice(0, 2).toLowerCase();
  const score = (track) => {
    const lang = (track.languageCode || "").slice(0, 2).toLowerCase();
    let value = 0;
    if (lang === pref) value += 200;
    else if (lang === "en") value += 80;
    if (!track.isAuto) value += 40;
    return value;
  };
  return [...tracks].sort((a, b) => score(b) - score(a));
}

export function parseJson3(data) {
  const cues = [];
  for (const event of data.events || []) {
    if (!event.segs) continue;
    const raw = event.segs.map((seg) => seg.utf8 || "").join("");
    const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (!text) continue;
    cues.push({
      startMs: event.tStartMs || 0,
      durationMs: event.dDurationMs || 0,
      text,
    });
  }
  return cues;
}

export function parseVtt(vtt) {
  const cues = [];
  const normalized = vtt.replace(/\r/g, "");
  const blocks = normalized.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !trimmed.startsWith("WEBVTT") &&
        !trimmed.startsWith("Kind:") &&
        !trimmed.startsWith("Language:") &&
        !trimmed.startsWith("NOTE") &&
        !trimmed.startsWith("Style:")
      );
    });
    const timeIdx = lines.findIndex((line) => line.includes("-->"));
    if (timeIdx === -1) continue;
    const [startRaw, endRaw] = lines[timeIdx].split("-->");
    const startMs = parseTimestamp(startRaw.trim());
    const endMs = parseTimestamp(endRaw.trim().split(" ")[0]);
    const text = decodeEntities(
      lines
        .slice(timeIdx + 1)
        .join(" ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!text) continue;
    cues.push({
      startMs,
      durationMs: Math.max(0, endMs - startMs),
      text,
    });
  }
  return cues;
}

export function parseSrv3(xml) {
  const cues = [];
  const pTags = xml.match(/<p[\s\S]*?<\/p>/g) || [];
  for (const tag of pTags) {
    const start = Number((tag.match(/\bt="(\d+)"/) || [])[1] || 0);
    const duration = Number((tag.match(/\bd="(\d+)"/) || [])[1] || 0);
    const text = decodeEntities(
      tag
        .replace(/<s[^>]*>/g, "")
        .replace(/<\/s>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!text) continue;
    cues.push({ startMs: start, durationMs: duration, text });
  }
  return cues;
}

export function parseSrv1(xml) {
  const cues = [];
  const tags = xml.match(/<text[\s\S]*?<\/text>/g) || [];
  for (const tag of tags) {
    const start = Number((tag.match(/\bstart="([0-9.]+)"/) || [])[1] || 0);
    const duration = Number((tag.match(/\bdur="([0-9.]+)"/) || [])[1] || 0);
    const text = decodeEntities(
      tag
        .replace(/<text[^>]*>/, "")
        .replace(/<\/text>/, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!text) continue;
    cues.push({
      startMs: Math.round(start * 1000),
      durationMs: Math.round(duration * 1000),
      text,
    });
  }
  return cues;
}

export function parseCaptionPayload(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    try {
      return parseJson3(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  if (trimmed.startsWith("WEBVTT") || trimmed.includes("-->")) return parseVtt(trimmed);
  if (/<text[\s>]/.test(trimmed)) return parseSrv1(trimmed);
  if (/<p[\s>]/.test(trimmed) || /<timedtext/.test(trimmed)) return parseSrv3(trimmed);
  return [];
}

function parseTimestamp(value) {
  const clean = value.replace(",", ".").trim();
  const parts = clean.split(":");
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    hours = Number(parts[0]);
    minutes = Number(parts[1]);
    seconds = Number(parts[2]);
  } else if (parts.length === 2) {
    minutes = Number(parts[0]);
    seconds = Number(parts[1]);
  } else {
    seconds = Number(parts[0]);
  }
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function wordOverlapCount(previous, next) {
  const a = previous.split(" ").filter(Boolean);
  const b = next.split(" ").filter(Boolean);
  const max = Math.min(a.length, b.length);
  for (let n = max; n >= 2; n -= 1) {
    if (a.slice(-n).join(" ").toLowerCase() === b.slice(0, n).join(" ").toLowerCase()) {
      return n;
    }
  }
  if (
    max >= 1 &&
    a[a.length - 1].toLowerCase() === b[0].toLowerCase() &&
    b[0].length > 4
  ) {
    return 1;
  }
  return 0;
}

export function dedupeCues(cues) {
  const out = [];
  for (const cue of cues) {
    if (!out.length) {
      out.push({ ...cue });
      continue;
    }
    const last = out[out.length - 1];
    if (cue.text === last.text) {
      last.durationMs = Math.max(
        last.durationMs,
        cue.startMs + cue.durationMs - last.startMs
      );
      continue;
    }
    const overlap = wordOverlapCount(last.text, cue.text);
    if (overlap > 0) {
      const extra = cue.text.split(" ").filter(Boolean).slice(overlap).join(" ");
      if (extra) last.text = `${last.text} ${extra}`.replace(/\s+/g, " ").trim();
      last.durationMs = Math.max(
        last.durationMs,
        cue.startMs + cue.durationMs - last.startMs
      );
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

function tidyText(text) {
  return text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?=[^\s,.;:!?)\]])/g, "$1 ")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/\s+'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function fixEnglishPronouns(text) {
  return text
    .replace(/\bi'm\b/gi, "I'm")
    .replace(/\bi've\b/gi, "I've")
    .replace(/\bi'll\b/gi, "I'll")
    .replace(/\bi'd\b/gi, "I'd")
    .replace(/\bi\b/g, "I");
}

function maybeQuestion(text) {
  if (/[?]$/.test(text)) return text;
  if (/(hasn't it|haven't they|don't you|doesn't it|isn't it|aren't they|couldn't we|wouldn't it|am i right)$/i.test(text)) {
    return `${text.replace(/[.!]+$/, "")}?`;
  }
  const words = text.split(/\s+/);
  if (
    words.length <= 6 &&
    /^(how|why|are you|is it|do you|can you|who is|who are)\b/i.test(text)
  ) {
    return `${text.replace(/[.!]+$/, "")}?`;
  }
  return text;
}

function isNewThought(text) {
  return /^(um+|uh+|anyway\b|okay\b|ok\b|alright\b|all right\b|well\b|now\b|so,)/i.test(text.trim());
}

function finishSentence(text, language) {
  let next = tidyText(text);
  if (!next) return next;
  if (SOUND_RE.test(next)) return next;
  if ((language || "en").slice(0, 2).toLowerCase() === "en") {
    next = fixEnglishPronouns(next);
  }
  next = next.charAt(0).toUpperCase() + next.slice(1);
  next = maybeQuestion(next);
  if (!/[.!?]$/.test(next)) next += ".";
  return next;
}

function joinCues(cues, language) {
  const sentences = [];
  let current = "";
  let lastStart = 0;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) sentences.push(finishSentence(trimmed, language));
    current = "";
  };

  for (const cue of cues) {
    const piece = cue.text.trim();
    if (!piece) continue;
    if (!current) {
      current = piece;
      lastStart = cue.startMs;
      continue;
    }
    const gap = cue.startMs - lastStart;
    if (gap >= 4000 || isNewThought(piece)) {
      push();
      current = piece;
    } else {
      current = `${current} ${piece}`;
    }
    lastStart = cue.startMs;
  }
  push();
  return sentences.join(" ");
}

export function toParagraphs(cues, options = {}) {
  const pauseBreakMs = typeof options === "number" ? options : options.pauseBreakMs ?? 5200;
  const language = typeof options === "number" ? "en" : options.language || "en";
  const paragraphs = [];
  let bucket = [];
  let lastStart = 0;

  const flush = () => {
    if (!bucket.length) return;
    paragraphs.push({
      startMs: bucket[0].startMs,
      endMs: bucket[bucket.length - 1].startMs + bucket[bucket.length - 1].durationMs,
      text: joinCues(bucket, language),
      sound: false,
    });
    bucket = [];
  };

  for (const cue of cues) {
    const isSound = SOUND_RE.test(cue.text);
    const gap = lastStart ? cue.startMs - lastStart : 0;
    if (bucket.length && (isSound || gap > pauseBreakMs)) flush();
    if (isSound) {
      paragraphs.push({
        startMs: cue.startMs,
        endMs: cue.startMs + cue.durationMs,
        text: cue.text,
        sound: true,
      });
    } else {
      bucket.push(cue);
    }
    lastStart = cue.startMs;
  }
  flush();
  return paragraphs.filter((paragraph) => paragraph.text);
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatSrtTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function toPlainText(paragraphs, { timestamps = false } = {}) {
  return paragraphs
    .map((paragraph) => {
      if (paragraph.sound) return paragraph.text;
      if (!timestamps) return paragraph.text;
      return `[${formatClock(paragraph.startMs)}] ${paragraph.text}`;
    })
    .join("\n\n");
}

export function toSrt(cues) {
  return cues
    .map((cue, index) => {
      const end = cue.startMs + Math.max(cue.durationMs, 800);
      return `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(end)}\n${cue.text}\n`;
    })
    .join("\n");
}

export function buildCaptionUrl(baseUrl, fmt) {
  const url = new URL(baseUrl);
  if (fmt) url.searchParams.set("fmt", fmt);
  return url.toString();
}

export function videoMeta(player, videoId) {
  const details = player?.videoDetails || {};
  const seconds = Number(
    player?.microformat?.playerMicroformatRenderer?.lengthSeconds || details.lengthSeconds || 0
  );
  return {
    videoId,
    title: details.title || "YouTube video",
    author: details.author || "",
    lengthSeconds: seconds,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
