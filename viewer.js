import { formatClock } from "./shared.js";

const els = {
  title: document.getElementById("title"),
  channel: document.getElementById("channel"),
  timestamps: document.getElementById("timestamps"),
  copy: document.getElementById("copy"),
  txt: document.getElementById("txt"),
  srt: document.getElementById("srt"),
  watch: document.getElementById("watch"),
  search: document.getElementById("search"),
  transcript: document.getElementById("transcript"),
};

let current = null;

const stored = await chrome.storage.local.get("lastTranscript");
current = stored.lastTranscript || null;
if (!current) {
  els.transcript.innerHTML = "<p class='p'>Generate a transcript from the extension popup first.</p>";
} else {
  render();
}

els.timestamps.addEventListener("change", render);
els.search.addEventListener("input", render);
els.copy.addEventListener("click", async () => {
  if (!current) return;
  await navigator.clipboard.writeText(els.timestamps.checked ? current.textWithTimestamps : current.text);
  els.copy.textContent = "Copied";
  setTimeout(() => {
    els.copy.textContent = "Copy";
  }, 1200);
});
els.txt.addEventListener("click", () => save("txt"));
els.srt.addEventListener("click", () => save("srt"));

function render() {
  if (!current) return;
  els.title.textContent = current.meta.title;
  els.channel.textContent = current.meta.author;
  els.watch.href = current.meta.url;
  els.watch.classList.remove("hidden");
  const query = els.search.value.trim();
  const showTime = els.timestamps.checked;
  els.transcript.innerHTML = current.paragraphs
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

function save(kind) {
  if (!current) return;
  const slug = (current.meta.title || "transcript").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const content = kind === "srt" ? current.srt : els.timestamps.checked ? current.textWithTimestamps : current.text;
  const blob = new Blob([content], { type: kind === "srt" ? "application/x-subrip" : "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.${kind}`;
  link.click();
  URL.revokeObjectURL(url);
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
