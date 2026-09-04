(function () {
  const videoId = window.__playtextVideoId || new URLSearchParams(window.location.search).get("v");
  window.__playtextState = { done: false, result: null };

  (async function run() {
    try {
      if (!videoId) throw new Error("No YouTube video on this page.");

      const fromApi = await fetchOfficialTranscript();
      if (fromApi && fromApi.length) {
        finishCues(fromApi);
        return;
      }

      const fromCaptions = await fetchAndroidCaptions(videoId);
      if (fromCaptions && fromCaptions.payload) {
        window.__playtextState = { done: true, result: fromCaptions };
        return;
      }

      const fromDom = await scrapeTranscriptPanel();
      if (fromDom && fromDom.length) {
        finishCues(fromDom);
        return;
      }

      throw new Error("YouTube did not return a transcript.");
    } catch (error) {
      window.__playtextState = {
        done: true,
        result: { ok: false, error: error.message || String(error) },
      };
    }
  })();

  function finishCues(cues) {
    const details = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails) || {};
    window.__playtextState = {
      done: true,
      result: {
        ok: true,
        cues,
        meta: {
          videoId,
          title: details.title || "",
          author: details.author || "",
        },
      },
    };
  }

  function ytcfgGet(key) {
    try {
      return window.ytcfg && window.ytcfg.get ? window.ytcfg.get(key) : null;
    } catch (e) {
      return null;
    }
  }

  function findParams(root) {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (node.getTranscriptEndpoint && node.getTranscriptEndpoint.params) {
        return node.getTranscriptEndpoint.params;
      }
      const values = Array.isArray(node) ? node : Object.values(node);
      for (let i = 0; i < values.length; i += 1) stack.push(values[i]);
    }
    return null;
  }

  function parseSegments(root) {
    const cues = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const seg = node.transcriptSegmentRenderer;
      if (seg) {
        const text = snippetText(seg.snippet || seg.cue);
        const startMs = Number(seg.startMs || 0);
        const endMs = Number(seg.endMs || startMs);
        if (text) cues.push({ startMs, durationMs: Math.max(400, endMs - startMs), text });
      }
      const cue = node.transcriptCueRenderer;
      if (cue) {
        const text = snippetText(cue.cue || cue.snippet);
        const startMs = Number(cue.startOffsetMs || cue.startMs || 0);
        const durationMs = Number(cue.durationMs || 2000);
        if (text) cues.push({ startMs, durationMs, text });
      }
      const values = Array.isArray(node) ? node : Object.values(node);
      for (let i = 0; i < values.length; i += 1) stack.push(values[i]);
    }
    cues.sort(function (a, b) { return a.startMs - b.startMs; });
    return cues;
  }

  function snippetText(snippet) {
    if (!snippet) return "";
    if (snippet.simpleText) return String(snippet.simpleText).replace(/\s+/g, " ").trim();
    if (Array.isArray(snippet.runs)) {
      return snippet.runs.map(function (run) { return run.text || ""; }).join("").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  async function fetchOfficialTranscript() {
    const context = ytcfgGet("INNERTUBE_CONTEXT");
    const key = ytcfgGet("INNERTUBE_API_KEY");
    const visitor = ytcfgGet("VISITOR_DATA") || (context && context.client && context.client.visitorData);
    const params = findParams(window.ytInitialData);
    if (!context || !params) return [];
    const url =
      "https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false" +
      (key ? "&key=" + encodeURIComponent(key) : "");
    const headers = { "Content-Type": "application/json" };
    if (visitor) headers["X-Goog-Visitor-Id"] = visitor;
    if (context.client && context.client.clientVersion) {
      headers["X-Youtube-Client-Version"] = context.client.clientVersion;
      headers["X-Youtube-Client-Name"] = "1";
    }
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: JSON.stringify({ context: context, params: params }),
    });
    if (!response.ok) return [];
    const json = await response.json();
    return parseSegments(json);
  }

  async function fetchAndroidCaptions(id) {
    const clients = [
      { clientName: "ANDROID", clientVersion: "20.10.38" },
      { clientName: "IOS", clientVersion: "20.10.38" },
    ];
    for (let c = 0; c < clients.length; c += 1) {
      const player = await postPlayer(id, clients[c]);
      const tracks = (player.captions &&
        player.captions.playerCaptionsTracklistRenderer &&
        player.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      tracks.sort(function (a, b) { return Number(a.kind === "asr") - Number(b.kind === "asr"); });
      for (let i = 0; i < tracks.length; i += 1) {
        const payload = await downloadTrack(tracks[i].baseUrl);
        if (payload) {
          return {
            ok: true,
            payload: payload,
            tracks: tracks,
            meta: {
              videoId: id,
              title: (player.videoDetails && player.videoDetails.title) || "",
              author: (player.videoDetails && player.videoDetails.author) || "",
            },
          };
        }
      }
    }
    return null;
  }

  async function postPlayer(id, client) {
    const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { hl: "en", gl: "US", clientName: client.clientName, clientVersion: client.clientVersion } },
        videoId: id,
      }),
    });
    if (!response.ok) throw new Error("player " + response.status);
    return response.json();
  }

  async function downloadTrack(baseUrl) {
    const formats = ["json3", "vtt", "srv3", ""];
    for (let i = 0; i < formats.length; i += 1) {
      const url = new URL(baseUrl);
      if (formats[i]) url.searchParams.set("fmt", formats[i]);
      const response = await fetch(url.toString(), { credentials: "omit" });
      if (!response.ok) continue;
      const text = await response.text();
      if (text && text.trim().length > 40) return text;
    }
    return "";
  }

  function parseClock(value) {
    const parts = String(value || "").trim().split(":");
    if (parts.length === 3) return (Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])) * 1000;
    if (parts.length === 2) return (Number(parts[0]) * 60 + Number(parts[1])) * 1000;
    return 0;
  }

  function readSegments() {
    const nodes = document.querySelectorAll("ytd-transcript-segment-renderer, yt-transcript-segment-renderer");
    const cues = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const text = ((node.querySelector("#segment-text, .segment-text") && node.querySelector("#segment-text, .segment-text").textContent) || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const stamp = ((node.querySelector("#segment-timestamp, .segment-timestamp") && node.querySelector("#segment-timestamp, .segment-timestamp").textContent) || "").trim();
      cues.push({ startMs: parseClock(stamp), durationMs: 2000, text: text });
    }
    for (let i = 0; i < cues.length - 1; i += 1) {
      const gap = cues[i + 1].startMs - cues[i].startMs;
      if (gap > 0) cues[i].durationMs = gap;
    }
    return cues;
  }

  async function scrapeTranscriptPanel() {
    const existing = readSegments();
    if (existing.length) return existing;
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
    );
    if (panel) panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    const expand = document.querySelector("#expand, ytd-text-inline-expander #expand");
    if (expand) expand.click();
    await new Promise(function (resolve) { setTimeout(resolve, 400); });
    const buttons = document.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i += 1) {
      const label = (buttons[i].getAttribute("aria-label") || "") + " " + (buttons[i].textContent || "");
      if (/transcript|ट्रांस्क्रिप्ट|प्रतिलेख/i.test(label)) {
        buttons[i].click();
        break;
      }
    }
    for (let i = 0; i < 16; i += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      const cues = readSegments();
      if (cues.length) return cues;
    }
    return [];
  }
})();
