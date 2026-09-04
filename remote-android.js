export async function fetchAndroidTranscript(videoId) {
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
          clientName: "ANDROID",
          clientVersion: "20.10.38",
          hl: "en",
          gl: "US",
        },
      },
      videoId,
    }),
  });
  if (!response.ok) throw new Error("YouTube player HTTP " + response.status);
  const player = await response.json();
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return null;
  tracks.sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
  for (const track of tracks) {
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");
    const cap = await fetch(url.toString(), { credentials: "omit" });
    if (!cap.ok) continue;
    const payload = await cap.text();
    if (payload && payload.trim().length > 40) {
      return {
        ok: true,
        payload,
        tracks,
        meta: {
          videoId,
          title: player.videoDetails?.title || "",
          author: player.videoDetails?.author || "",
        },
      };
    }
  }
  return null;
}
