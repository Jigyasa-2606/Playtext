(function playtextInject() {
  if (window.__playtextInjected) return;
  window.__playtextInjected = true;

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "playtext" || event.data?.type !== "FETCH") return;
    const { requestId, videoId } = event.data;
    try {
      const result = await downloadCaptions(videoId);
      window.postMessage({ source: "playtext", type: "RESULT", requestId, ok: true, result }, "*");
    } catch (error) {
      window.postMessage(
        { source: "playtext", type: "RESULT", requestId, ok: false, error: error.message || String(error) },
        "*"
      );
    }
  });

  async function downloadCaptions(videoId) {
    const players = [];
    for (const client of [
      { clientName: "ANDROID", clientVersion: "20.10.38" },
      { clientName: "IOS", clientVersion: "20.10.38" },
    ]) {
      try {
        const player = await postPlayer(videoId, client);
        players.push(player);
        const tracks = captionTracks(player);
        if (!tracks.length) continue;
        tracks.sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
        for (const track of tracks) {
          const payload = await downloadTrack(track.baseUrl);
          if (payload) {
            return {
              payload,
              track,
              tracks,
              meta: {
                videoId,
                title: player.videoDetails?.title || "",
                author: player.videoDetails?.author || "",
              },
            };
          }
        }
      } catch {
        // next client
      }
    }
    throw new Error("YouTube returned empty captions from the page.");
  }

  async function postPlayer(videoId, client) {
    const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { hl: "en", gl: "US", ...client } },
        videoId,
      }),
    });
    if (!response.ok) throw new Error(`player ${response.status}`);
    return response.json();
  }

  function captionTracks(player) {
    return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  async function downloadTrack(baseUrl) {
    const formats = ["json3", "vtt", "srv3", ""];
    for (const fmt of formats) {
      const url = new URL(baseUrl);
      if (fmt) url.searchParams.set("fmt", fmt);
      const response = await fetch(url.toString(), { credentials: "omit" });
      if (!response.ok) continue;
      const text = await response.text();
      if (text && text.trim().length > 40) return text;
    }
    return "";
  }
})();
