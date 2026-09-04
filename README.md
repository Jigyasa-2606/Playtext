# Playtext

Chrome extension that turns a YouTube video into a clean, readable transcript.

Paste a link or open a video, click **Generate**, and get text you can copy, search, or download. Playtext does not invent speech from the audio. It uses captions already on the video — official first, auto-generated if that is all YouTube has — then stitches overlapping subtitle lines into paragraphs.

## Features

- Detects the YouTube video in the current tab, or accepts a pasted URL
- Prefers official / uploaded captions, then falls back to auto-captions
- Cleans overlapping auto-caption fragments and extra spacing
- Groups lines into readable paragraphs
- Optional timestamps
- Copy, in-transcript search, download `.txt` or `.srt`
- Full-page view for long lectures
- Keyboard shortcut: `Alt+Shift+Y`

## Install

1. Clone this repo, or download the folder
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select this project folder
6. Pin Playtext from the puzzle-piece menu

If the extension is already loaded, click **Reload** on its card and accept any new permission Chrome asks for.

## Use

1. Open a YouTube video
2. Click the Playtext icon
3. Click **Generate transcript**
4. Copy the text, search it, or download TXT / SRT

Stay on the YouTube tab while you generate. The popup should show **v1.5** under the title after a fresh load.

## How it works

Most YouTube videos already have caption tracks. Playtext reads those tracks from the watch page, picks the best available language, and formats them into a transcript.

The last result is stored in Chrome’s local extension storage on your machine so you can reopen it. Nothing is uploaded to a Playtext server — there isn’t one.

## Limits

- Videos with no captions cannot be transcribed
- Private or age-restricted videos may fail if Chrome is not signed into YouTube
- Transcript quality follows the source captions. Official tracks read best. Auto-captions are cleaned up, but they still reflect what YouTube generated

## Privacy

Playtext only reads the video you asked it to transcribe. It does not create an account, does not run analytics, and does not sell data.

## Project

```
popup.html / popup.js     Extension popup
viewer.html               Full transcript page
background.js             Service worker
extract-page.js           Reads captions from the YouTube tab
shared.js                 URL parsing and transcript cleanup
```

Manifest V3. Load this folder as an unpacked extension to run it locally.
