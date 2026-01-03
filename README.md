# Abacus ChatLLM Exporter

Export your Abacus ChatLLM conversations from a logged-in browser session, clean the data, and review it locally in an offline viewer.

This repository intentionally ships only code and documentation. It does **not** include cookies, session dumps, HAR files, screenshots, or conversation exports.

## What this repo includes

- `abacus-console-exporter.js`
  Browser-console exporter that walks the sidebar, opens each conversation, and saves JSON.
- `abacus-id-collector.js`
  Browser-console helper that collects conversation IDs and titles for the offline fetcher flow.
- `abacus-offline-fetcher/`
  Puppeteer-based fetcher that replays an authenticated browser session using your local cookies.
- `merge-abacus-exports.js`
  Combines multiple export files into a single bundle.
- `clean_export.py`
  Normalizes raw exports into cleaner archive formats for search, review, and downstream processing.
- `viewer/`
  Static local viewer for browsing exported conversations offline.
- `docs/images/`
  Reserved for redacted screenshots if you want to add GitHub visuals later.

## Requirements

- Node.js 18+
- Python 3.10+
- A logged-in Abacus ChatLLM browser session

## Quick start

### 1. Export from the browser

Open Abacus ChatLLM in your browser, open DevTools, paste `abacus-console-exporter.js` into the console, and run it.

Set the top-level config first:

- `MODE = "chats"` for regular chats
- `MODE = "projects"` for project conversations
- `MAX_CHATS = Infinity` to export everything, or a smaller number while testing

The script downloads:

- `abacus-export-chats.json`
- `abacus-export-projects.json`

### 2. Optional: collect IDs for the offline fetcher path

If you want a second workflow that renders each conversation in headless Chromium, run `abacus-id-collector.js` in the browser console first. That produces `abacus-ids.json`.

Install the fetcher dependency:

```bash
cd abacus-offline-fetcher
npm install
```

Then run:

```bash
node index.js --ids ../abacus-ids.json --cookies ../cookies.txt
```

You can use either `cookies.txt` or `cookies.json`, but keep them local and uncommitted.

### 3. Merge exports

From the repository root:

```bash
node merge-abacus-exports.js
```

This writes:

- `abacus-export-bundle.json`

You can also pass explicit files:

```bash
node merge-abacus-exports.js /path/to/abacus-export-chats.json /path/to/abacus-export-projects.json --out abacus-export-bundle.json
```

### 4. Clean the raw export

```bash
python3 clean_export.py abacus-export-bundle.json
```

Outputs:

- `clean-archive.json`
- `clean-archive.jsonl`

### 5. Review locally in the viewer

Serve the repository from the root:

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/viewer/`

The viewer will try to auto-load common export filenames from the repository root, or you can drag and drop JSON files into it.

## Recommended workflow

1. Use the console exporter to get the broadest raw capture.
2. Use the offline fetcher if you need a second pass or DOM-rendered extraction.
3. Merge the resulting files.
4. Run `clean_export.py`.
5. Inspect the result in `viewer/`.

## Security and publication checklist

Before pushing anything to GitHub:

- Do not commit `cookies.txt`, `cookies.json`, local/session storage dumps, or HAR files.
- Do not commit raw chat exports that contain your private conversations.
- Do not publish screenshots unless you have redacted chat titles, project names, account names, and other personal context.
- Rotate any real API key you may have used in earlier experiments.

The included `.gitignore` blocks the most common sensitive artifacts, but you should still review `git status` before every commit.

## Adding a screenshot later

If you want a screenshot on the GitHub page, place a redacted image under `docs/images/`, for example:

- `docs/images/viewer-redacted.png`

Then reference it from this README with standard Markdown.
