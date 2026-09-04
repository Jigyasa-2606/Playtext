export async function extractYouTubeTranscript(videoId) {
  function ytcfgGet(key) {
    try {
      if (window.ytcfg && window.ytcfg.get) return window.ytcfg.get(key);
      if (window.ytcfg && window.ytcfg.data_) return window.ytcfg.data_[key];
    } catch (e) {
      return null;
    }
    return null;
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

  function snippetText(snippet) {
    if (!snippet) return "";
    if (snippet.simpleText) return String(snippet.simpleText).replace(/\s+/g, " ").trim();
    if (Array.isArray(snippet.runs)) {
      return snippet.runs
        .map(function (run) {
          return run.text || "";
        })
        .join("")
        .replace(/\s+/g, " ")
        .trim();
    }
    return "";
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
        if (text) cues.push({ startMs: startMs, durationMs: Math.max(400, endMs - startMs), text: text });
      }
      const cue = node.transcriptCueRenderer;
      if (cue) {
        const text = snippetText(cue.cue || cue.snippet);
        const startMs = Number(cue.startOffsetMs || cue.startMs || 0);
        if (text) cues.push({ startMs: startMs, durationMs: Number(cue.durationMs || 2000), text: text });
      }
      const values = Array.isArray(node) ? node : Object.values(node);
      for (let i = 0; i < values.length; i += 1) stack.push(values[i]);
    }
    cues.sort(function (a, b) {
      return a.startMs - b.startMs;
    });
    return cues;
  }

  function details() {
    const video = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails) || {};
    return { title: video.title || document.title.replace(/ - YouTube$/, ""), author: video.author || "" };
  }

  async function fromTranscriptApi() {
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
    return parseSegments(await response.json());
  }

  async function fromAndroid() {
    const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { hl: "en", gl: "US", clientName: "ANDROID", clientVersion: "20.10.38" } },
        videoId: videoId,
      }),
    });
    if (!response.ok) return null;
    const player = await response.json();
    const tracks =
      (player.captions &&
        player.captions.playerCaptionsTracklistRenderer &&
        player.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    tracks.sort(function (a, b) {
      return Number(a.kind === "asr") - Number(b.kind === "asr");
    });
    for (let i = 0; i < tracks.length; i += 1) {
      const url = new URL(tracks[i].baseUrl);
      url.searchParams.set("fmt", "json3");
      const cap = await fetch(url.toString(), { credentials: "omit" });
      const text = await cap.text();
      if (text && text.trim().length > 40) {
        return {
          payload: text,
          meta: {
            title: (player.videoDetails && player.videoDetails.title) || "",
            author: (player.videoDetails && player.videoDetails.author) || "",
          },
        };
      }
    }
    return null;
  }

  function readDom() {
    const nodes = document.querySelectorAll("ytd-transcript-segment-renderer, yt-transcript-segment-renderer");
    const cues = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const textEl = node.querySelector("#segment-text, .segment-text");
      const timeEl = node.querySelector("#segment-timestamp, .segment-timestamp");
      const text = ((textEl && textEl.textContent) || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const stamp = ((timeEl && timeEl.textContent) || "").trim().split(":");
      let startMs = 0;
      if (stamp.length === 3) startMs = (Number(stamp[0]) * 3600 + Number(stamp[1]) * 60 + Number(stamp[2])) * 1000;
      else if (stamp.length === 2) startMs = (Number(stamp[0]) * 60 + Number(stamp[1])) * 1000;
      cues.push({ startMs: startMs, durationMs: 2000, text: text });
    }
    return cues;
  }

  async function fromDom() {
    let cues = readDom();
    if (cues.length) return cues;
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
    );
    if (panel) panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    await new Promise(function (resolve) {
      setTimeout(resolve, 600);
    });
    return readDom();
  }

  const meta = details();
  const apiCues = await fromTranscriptApi();
  if (apiCues.length) return { ok: true, cues: apiCues, meta: meta };
  const android = await fromAndroid();
  if (android && android.payload) return { ok: true, payload: android.payload, meta: android.meta || meta };
  const domCues = await fromDom();
  if (domCues.length) return { ok: true, cues: domCues, meta: meta };
  return { ok: false, error: "YouTube page had no transcript data." };
}
