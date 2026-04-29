#!/usr/bin/env node
/**
 * Abacus ChatLLM — Offline Fetcher
 * ─────────────────────────────────
 * Renders each conversation URL in headless Chromium using your saved browser
 * cookies, extracts messages, and outputs a clean JSON ready for the viewer.
 *
 * USAGE
 *   node index.js [options]
 *
 * OPTIONS
 *   --ids <file>        Path to abacus-ids.json from the ID collector console script
 *                       (default: ../abacus-ids.json)
 *   --cookies <file>    Path to cookies.txt (Netscape/tab format) or cookies.json
 *                       (default: ../cookies.txt)
 *   --out <file>        Output path (default: ../abacus-export-chats.json)
 *   --workers <n>       Number of parallel browser tabs (default: 5)
 *   --limit <n>         Only process the first N conversations (for testing)
 *   --resume            Skip conversations already in the output file
 *   --timeout <ms>      Max ms to wait for a chat to render (default: 15000)
 *
 * HOW TO GET YOUR COOKIES
 *   Option A — Copy as Header (fastest):
 *     1. Open https://apps.abacus.ai/chatllm/ in your browser
 *     2. Open DevTools → Network tab
 *     3. Refresh, click any request to apps.abacus.ai
 *     4. In the request headers, right-click the "cookie:" line → Copy value
 *     5. Create cookies.txt and paste it as one line
 *
 *   Option B — Export as JSON (more reliable):
 *     1. Install the "EditThisCookie" or "Cookie-Editor" browser extension
 *     2. Navigate to https://apps.abacus.ai
 *     3. Export cookies as JSON → save as cookies.json
 *
 *   Option C — Edit cookies.txt with the cookie string:
 *     Just put your full cookie header value on a single line in cookies.txt
 */

"use strict";

const puppeteer  = require("puppeteer");
const fs         = require("fs");
const path       = require("path");

/* ── CLI args ────────────────────────────────────────────────────────── */

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) {
    const key = process.argv[i].slice(2);
    args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
      ? process.argv[++i]
      : true;
  }
}

const IDS_FILE     = args.ids      || path.join(__dirname, "..", "abacus-ids.json");
const COOKIES_FILE = args.cookies  || path.join(__dirname, "..", "cookies.txt");
const OUT_FILE     = args.out      || path.join(__dirname, "..", "abacus-export-chats.json");
const WORKERS      = parseInt(args.workers || "5", 10);
const LIMIT        = args.limit    ? parseInt(args.limit, 10) : Infinity;
const RESUME       = !!args.resume;
const TIMEOUT_MS   = parseInt(args.timeout || "15000", 10);

/* ── Cookie loader ───────────────────────────────────────────────────── */

function loadCookies() {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`\n❌ Cookie file not found: ${COOKIES_FILE}`);
    console.error("See the usage comments at the top of this file for how to get your cookies.\n");
    process.exit(1);
  }

  const raw = fs.readFileSync(COOKIES_FILE, "utf8").trim();

  // Format 1: JSON array (from extension export)
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      return arr.map(c => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain   || ".abacus.ai",
        path:     c.path     || "/",
        httpOnly: !!c.httpOnly,
        secure:   !!c.secure,
        sameSite: c.sameSite || "Lax",
      }));
    } catch (e) {
      console.error("Could not parse cookies.json as JSON array:", e.message);
      process.exit(1);
    }
  }

  // Format 2: Single cookie header string  e.g.  _ga=xxx; session=yyy; ...
  if (raw.includes("=") && !raw.startsWith("#")) {
    const cookies = [];
    for (const part of raw.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      const name  = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (name) cookies.push({ name, value, domain: ".abacus.ai", path: "/" });
    }
    return cookies;
  }

  // Format 3: Netscape cookies.txt
  const cookies = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    cookies.push({
      domain:   parts[0],
      httpOnly: parts[1] === "TRUE",
      path:     parts[2],
      secure:   parts[3] === "TRUE",
      expires:  parseInt(parts[4], 10) || undefined,
      name:     parts[5],
      value:    parts[6].trim(),
    });
  }
  return cookies;
}

/* ── Message extractor (runs inside the page via page.evaluate) ───────── */

const EXTRACTOR_FN = `
(function extractMessages() {
  const root = document.querySelector("#scroll-helper-bottom");
  if (!root) return { messages: [], error: "no-scroll-helper-bottom" };

  const msgEls = Array.from(root.querySelectorAll("[data-msg-isbot]"));
  if (!msgEls.length) {
    // Fallback: return all visible text
    return {
      messages: [{
        role: "unknown",
        text: (root.innerText || "").trim().slice(0, 20000),
        html: ""
      }],
      error: "no-data-msg-isbot"
    };
  }

  function getModelName(el) {
    const llmEl = el.querySelector('[data-id="llmname"], [data-id*="llmname"]');
    return llmEl ? llmEl.textContent.trim() : "";
  }

  function cleanContent(el) {
    const clone = el.cloneNode(true);

    // Remove non-content nodes
    clone.querySelectorAll(
      'svg, button, [data-id*="icon"], [data-id*="action"], [data-id*="feedback"],' +
      '[data-id*="copy"], [data-id*="react"], [data-id*="llmname"], [data-id*="time"],' +
      '[data-id*="menu"], [data-id*="more"], script, style, noscript'
    ).forEach(e => e.remove());

    // Try to find the actual content div
    const contentEl =
      clone.querySelector('[data-id^="msg-content"]') ||
      clone.querySelector('[data-id*="msg-content"]') ||
      clone.querySelector('.prose') ||
      clone;

    // Strip class attributes (Tailwind is useless without the runtime)
    const walk = document.createTreeWalker(contentEl, NodeFilter.SHOW_ELEMENT);
    let node = walk.currentNode;
    while (node) {
      node.removeAttribute("class");
      const style = node.getAttribute("style") || "";
      if (/opacity|transition|animation|transform/i.test(style)) node.removeAttribute("style");
      node = walk.nextNode();
    }

    const html = contentEl.innerHTML.trim();
    const text = (contentEl.innerText || contentEl.textContent || "")
      .replace(/\\n{3,}/g, "\\n\\n").trim();

    return { html, text };
  }

  const messages = [];
  const seen = new Set();

  for (const el of msgEls) {
    const isBot = el.getAttribute("data-msg-isbot");
    const role  = isBot === "1" ? "assistant" : isBot === "0" ? "user" : "unknown";
    const model = role === "assistant" ? getModelName(el) : "";
    const { html, text } = cleanContent(el);

    if (!text) continue;

    const sig = role + ":" + text.slice(0, 200);
    if (seen.has(sig)) continue;
    seen.add(sig);

    messages.push({ role, text, html, model: model || null });
  }

  return { messages, error: null };
})()
`;

/* ── Single conversation fetch ───────────────────────────────────────── */

async function fetchConversation(page, item) {
  try {
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });

    // Wait for messages to appear
    const startMs = Date.now();
    let result = null;

    while (Date.now() - startMs < TIMEOUT_MS) {
      result = await page.evaluate(new Function(`return ${EXTRACTOR_FN}`));
      if (result.messages && result.messages.length > 0 && result.error !== "no-scroll-helper-bottom") {
        // Wait a bit for DOM to stabilize (streaming messages)
        await new Promise(r => setTimeout(r, 600));
        // Re-extract after stabilization
        result = await page.evaluate(new Function(`return ${EXTRACTOR_FN}`));
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const messages = (result && result.messages) || [];
    const model = messages.find(m => m.model)?.model || null;

    return {
      conversationId: item.id,
      title:          item.title,
      section:        "chats",
      projectId:      null,
      projectName:    null,
      capturedAt:     new Date().toISOString(),
      model,
      messageCount:   messages.length,
      messages:       messages.map(({ role, text, html }) => ({ role, text, html })),
      error:          result?.error || null,
    };
  } catch (err) {
    return {
      conversationId: item.id,
      title:          item.title,
      section:        "chats",
      projectId:      null,
      projectName:    null,
      capturedAt:     new Date().toISOString(),
      model:          null,
      messageCount:   0,
      messages:       [],
      error:          err.message,
    };
  }
}

/* ── Worker pool ─────────────────────────────────────────────────────── */

async function runWorkers(items, browser, cookies, concurrency) {
  const results    = new Array(items.length);
  const queue      = items.map((item, i) => ({ item, i }));
  let   processed  = 0;
  const total      = items.length;

  async function worker(workerId) {
    const page = await browser.newPage();

    // Set cookies on the page
    await page.setCookie(...cookies);

    // Set a real user agent to avoid bot detection
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;

      const { item, i } = task;
      const result = await fetchConversation(page, item);
      results[i] = result;
      processed++;

      const pct    = ((processed / total) * 100).toFixed(1);
      const status = result.messageCount > 0 ? `✓ ${result.messageCount} msgs` : `⚠ ${result.error || "0 msgs"}`;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const eta     = processed > 0 ? Math.round((elapsed / processed) * (total - processed)) : "?";

      process.stdout.write(
        `\r[Worker ${workerId}] ${processed}/${total} (${pct}%) | ETA: ${eta}s | ${item.title.slice(0, 40).padEnd(40)} ${status}   `
      );
    }

    await page.close();
  }

  const startTime = Date.now();
  const workerPromises = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workerPromises);
  console.log(); // newline after progress

  return results;
}

/* ── Main ────────────────────────────────────────────────────────────── */

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(" Abacus ChatLLM Offline Fetcher");
  console.log("═══════════════════════════════════════════════════════");

  // Load IDs
  if (!fs.existsSync(IDS_FILE)) {
    console.error(`\n❌ IDs file not found: ${IDS_FILE}`);
    console.error("Run abacus-id-collector.js in the browser console first.\n");
    process.exit(1);
  }

  const idsData = JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
  let items = idsData.ids || [];

  if (LIMIT < Infinity) items = items.slice(0, LIMIT);

  // Resume: skip already-done IDs
  if (RESUME && fs.existsSync(OUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
    const doneIds  = new Set((existing.conversations || []).map(c => c.conversationId));
    const before   = items.length;
    items          = items.filter(i => !doneIds.has(i.id));
    console.log(`Resume mode: skipping ${before - items.length} already-fetched conversations.`);
  }

  console.log(`\nTotal conversations to fetch: ${items.length}`);
  console.log(`Workers: ${WORKERS} parallel browser tabs`);
  console.log(`Timeout per chat: ${TIMEOUT_MS / 1000}s`);
  console.log(`Estimated time: ~${Math.round(items.length / WORKERS * 2.5 / 60)} minutes\n`);

  // Load cookies
  const cookies = loadCookies();
  console.log(`Loaded ${cookies.length} cookies from ${COOKIES_FILE}`);

  // Launch browser (headless)
  console.log("Launching browser…\n");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  try {
    const results = await runWorkers(items, browser, cookies, WORKERS);

    // If resuming, merge with existing
    let allConversations = results;
    if (RESUME && fs.existsSync(OUT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
      const doneMap  = new Map((existing.conversations || []).map(c => [c.conversationId, c]));
      for (const c of results) doneMap.set(c.conversationId, c);
      allConversations = Array.from(doneMap.values());
    }

    const output = {
      schemaVersion: "2.0",
      source:        "abacus-chatllm",
      exportedAt:    new Date().toISOString(),
      mode:          idsData.mode || "chats",
      conversations: allConversations,
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

    const withMsgs  = allConversations.filter(c => c.messageCount > 0).length;
    const totalMsgs = allConversations.reduce((s, c) => s + c.messageCount, 0);
    const failed    = allConversations.filter(c => c.messageCount === 0).length;

    console.log("═══════════════════════════════════════════════════════");
    console.log(` Done! Output: ${OUT_FILE}`);
    console.log(`  ${withMsgs} conversations with messages`);
    console.log(`  ${totalMsgs} total messages`);
    if (failed > 0) console.log(`  ${failed} conversations failed (0 messages) — try --resume to retry`);
    console.log("═══════════════════════════════════════════════════════\n");

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});
