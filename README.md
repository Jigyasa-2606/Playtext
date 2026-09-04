# Playtext

Chrome extension that turns a YouTube video link into a clean, readable transcript.

It uses the captions already attached to the video (official first, auto-generated if that is all YouTube has), then stitches overlapping lines, fixes spacing, and groups the result into paragraphs.

## Install in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder
5. Pin Playtext from the puzzle-piece menu

## Use it

- Paste any YouTube URL into the popup, or open a YouTube video and click the extension — it fills the current video automatically
- Click **Generate transcript**
- Copy, search, download `.txt` / `.srt`, or open **Full view**
- Switch caption languages if the video has more than one track
- Optional shortcut: `Alt+Shift+Y`

Videos with no captions cannot be transcribed. Age-restricted or private videos may also fail depending on whether Chrome is signed into YouTube.
