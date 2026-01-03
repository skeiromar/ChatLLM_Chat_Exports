/*
 * Abacus ChatLLM Console Exporter  (schema v2.0)
 * ─────────────────────────────────────────────
 * Paste this into the browser console on the Abacus ChatLLM page.
 *
 * HOW IT WORKS
 *  1. Scrolls the sidebar to collect every chat row (filters out date headers).
 *  2. Clicks each row and waits until BOTH the URL updates AND the DOM content
 *     changes before capturing — this eliminates the "off-by-one" bug where the
 *     previous chat's content was captured instead of the new one.
 *  3. Extracts messages using the real Abacus attributes:
 *       data-msg-isbot="0"  →  user
 *       data-msg-isbot="1"  →  assistant
 *  4. Saves the rendered HTML (already markdown-rendered by Abacus) and clean
 *     plain text for each message.
 *  5. Downloads  abacus-export-chats.json  (or -projects.json) on completion.
 *
 * CONFIGURATION  (edit the block right below ↓)
 */

(async () => {

  /* ═══════════════════════ CONFIGURATION ═══════════════════════════════ */

  // "chats" → regular Chats page
  // "projects" → Projects page (have the target project already expanded)
  const MODE = "chats";

  // Seconds between finishing one chat capture and starting the next.
  // Lower = faster but more risk of hitting a loading error.
  const BETWEEN_CHATS_SEC = 1.0;

  // If the first chat in the list is already open, set this true to skip
  // clicking it (just capture what's rendered) and proceed with the rest.
  const FIRST_CHAT_ALREADY_OPEN = true;

  // Maximum chats to export — useful for testing. Set to Infinity for all.
  const MAX_CHATS = Infinity;

  /* ════════════════════════════════════════════════════════════════════ */

  const CFG = {
    scrollBatchMs:       800,    // delay between sidebar scroll steps
    maxScrollPasses:     220,    // maximum sidebar scroll attempts
    stablePasses:        3,      // stop scrolling when count stable this many times
    renderTimeoutMs:     12000,  // max ms to wait for a chat to render
    stabilizeMs:         350,    // DOM must be stable for this long before capture
    stabilizeMaxMs:      2500,   // ceiling for the stabilization wait
  };

  /* ── Utilities ──────────────────────────────────────────────────────── */

  const sleep  = ms => new Promise(r => setTimeout(r, ms));
  const qs     = (sel, root = document) => root.querySelector(sel);
  const qsa    = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const now    = () => new Date().toISOString();
  const urlParam = name => { try { return new URL(location.href).searchParams.get(name) || ""; } catch { return ""; } };

  /* ── Status badge ───────────────────────────────────────────────────── */

  function makeBadge() {
    const b = Object.assign(document.createElement("div"), {
      style: [
        "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
        "background:#0f172a", "color:#f1f5f9",
        "padding:10px 14px", "border:1px solid #334155", "border-radius:10px",
        "font:12px/1.4 ui-monospace,Menlo,Consolas,monospace",
        "box-shadow:0 8px 24px rgba(0,0,0,.45)", "max-width:440px",
        "white-space:pre-wrap"
      ].join(";")
    });
    document.body.appendChild(b);
    const self = {
      set(t)  { b.style.background = "#0f172a"; b.style.borderColor = "#334155"; b.textContent = t; },
      ok(t)   { b.style.background = "#14532d"; b.style.borderColor = "#22c55e"; b.textContent = t; },
      warn(t) { b.style.background = "#78350f"; b.style.borderColor = "#f59e0b"; b.textContent = t; },
      err(t)  { b.style.background = "#7f1d1d"; b.style.borderColor = "#f87171"; b.textContent = t; },
      gone(ms){ setTimeout(() => b.remove(), ms); }
    };
    return self;
  }

  /* ── Download ───────────────────────────────────────────────────────── */

  function download(data, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
  }

  /* ── Sidebar scrolling & row collection ─────────────────────────────── */

  function findSidebarScroller() {
    // The sidebar list container is the closest scrollable ancestor of
    // [data-id="containerFiltered"]
    const container = qs('[data-id="containerFiltered"]');
    if (!container) return document.scrollingElement || document.documentElement;
    let el = container;
    while (el) {
      if (el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Returns { conversationId, title, node } for every real chat row
  function snapshotRows() {
    const scope =
      MODE === "projects"
        ? (qs('[data-id="containerFiltered"]') || document)  // project chat list
        : (qs('[data-id="containerFiltered"]') || document);

    // Real chat rows have  id="task-convo-<hex>"  on themselves or a direct child.
    const rows = qsa('[id^="task-convo-"]', scope);
    const seen = new Map();

    for (const el of rows) {
      const rawId = el.id || "";
      const convoId = rawId.replace(/^task-convo-/, "").trim();
      if (!convoId || seen.has(convoId)) continue;

      // Title: walk up to the row's parent container and grab the span text
      const row = el.closest('[data-id^="task-convo-"]') || el.parentElement || el;
      let title = "";

      // Try data-title attribute first
      const withTitle = row.querySelector("[data-title]") || el.querySelector("[data-title]");
      if (withTitle) title = (withTitle.getAttribute("data-title") || "").trim();

      // Third child of parent row often has the title span
      if (!title) {
        const parentRow = el.parentElement;
        if (parentRow) {
          const thirdChild = parentRow.children[2];
          if (thirdChild) {
            const span = thirdChild.querySelector("span");
            if (span) title = (span.textContent || "").trim();
          }
        }
      }

      // Fallback: first non-empty span anywhere in the row
      if (!title) {
        for (const span of qsa("span", el.parentElement || el)) {
          const t = (span.textContent || "").trim();
          if (t && t.length < 200) { title = t; break; }
        }
      }

      // Determine clickable element (the row itself or closest li/div)
      const clickTarget = el.closest('[data-id^="task-convo-"]') || el.parentElement || el;

      seen.set(convoId, { conversationId: convoId, title: title || convoId, node: clickTarget });
    }

    return Array.from(seen.values());
  }

  async function collectAllRows() {
    const scroller = findSidebarScroller();
    scroller.scrollTop = 0;
    await sleep(200);

    const found = new Map();
    let stable = 0, lastCount = -1;

    for (let pass = 0; pass < CFG.maxScrollPasses; pass++) {
      for (const r of snapshotRows()) {
        if (!found.has(r.conversationId)) found.set(r.conversationId, r);
      }

      if (found.size === lastCount) { if (++stable >= CFG.stablePasses) break; }
      else { stable = 0; lastCount = found.size; }

      scroller.scrollTop = scroller.scrollHeight;
      await sleep(CFG.scrollBatchMs);
    }

    scroller.scrollTop = 0;
    await sleep(150);
    return Array.from(found.values());
  }

  /* ── Click a row ────────────────────────────────────────────────────── */

  function humanClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const x = r.left + Math.max(5, Math.min(20, r.width / 2));
    const y = r.top  + Math.max(5, Math.min(14, r.height / 2));
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    }
  }

  /* ── Wait for chat to render with strong double-check ───────────────── */

  // Strong content signature: uses Abacus-specific data-msg-isbot count + text tail.
  // This avoids false-positives from the URL changing before the DOM updates.
  function chatSig() {
    const root = qs("#scroll-helper-bottom");
    if (!root) return "none:0:";
    const msgs = qsa("[data-msg-isbot]", root);
    const text = (root.innerText || "").trim();
    return `${msgs.length}:${text.length}:${text.slice(-300)}`;
  }

  async function waitForStable(prevSig, targetConvoId) {
    const deadline = performance.now() + CFG.renderTimeoutMs;
    let stableSince = null;

    while (performance.now() < deadline) {
      await sleep(120);

      const currentConvoId = urlParam("convoId") || urlParam("deploymentConversationId");
      const urlOk = !targetConvoId || !currentConvoId || currentConvoId === targetConvoId;
      const sig = chatSig();
      const changed = sig !== prevSig;

      if (urlOk && changed) {
        if (!stableSince) { stableSince = performance.now(); continue; }
        if (performance.now() - stableSince >= CFG.stabilizeMs) return true;

        // Keep checking until stable or timeout
        const sig2 = chatSig();
        if (sig2 !== sig) stableSince = performance.now(); // reset if still changing
        else if (performance.now() - stableSince >= CFG.stabilizeMs) return true;
      }
    }
    return false; // timed out — capture whatever is there
  }

  /* ── Message extraction ─────────────────────────────────────────────── */

  // Strip all Tailwind / Abacus utility classes while preserving semantic attributes.
  function stripUtilityClasses(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      // Remove class attribute entirely — the viewer provides its own CSS.
      node.removeAttribute("class");
      // Remove inline opacity/transition styles that come from Abacus animations.
      const style = node.getAttribute("style") || "";
      if (/opacity|transition|animation|transform/i.test(style)) node.removeAttribute("style");
      node = walker.nextNode();
    }
  }

  function extractModelName(msgEl) {
    // [data-id="llmname"] is mentioned in the original doc as the model label.
    const llmEl = qs('[data-id="llmname"]', msgEl) || qs('[data-id*="llmname"]', msgEl);
    if (llmEl) return (llmEl.textContent || "").trim();
    return "";
  }

  function extractMessageContent(msgEl) {
    const clone = msgEl.cloneNode(true);

    // Remove non-content elements: icons, action buttons, feedback, copy, reactions
    const removeSelectors = [
      "svg", "button",
      "[data-id*='icon']",
      "[data-id*='action']",
      "[data-id*='feedback']",
      "[data-id*='copy']",
      "[data-id*='react']",
      "[data-id*='llmname']",   // model badge (captured separately)
      "[data-id*='time']",
      "[data-id*='menu']",
      "[data-id*='more']",
      "[data-id*='attachment']",
      "script", "style", "noscript",
    ];
    qsa(removeSelectors.join(","), clone).forEach(el => el.remove());

    // Try to find the actual content container
    // Abacus wraps rendered markdown in a div with data-id="msg-content-N"
    const contentEl = (
      qs('[data-id^="msg-content"]',   clone) ||
      qs('[data-id*="msg-content"]',   clone) ||
      qs('[data-id*="content"]',       clone) ||
      qs('.prose',                     clone) ||
      clone
    );

    // Strip utility classes so the viewer CSS works cleanly
    stripUtilityClasses(contentEl);

    const html = contentEl.innerHTML.trim();
    // innerText gives us newlines preserved; collapse excessive whitespace
    const text = (contentEl.innerText || contentEl.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { html, text };
  }

  function extractMessages(chatRoot, conversationId) {
    // Primary: use Abacus's own data-msg-isbot attribute
    const msgEls = qsa("[data-msg-isbot]", chatRoot);

    if (msgEls.length === 0) {
      // Fallback: capture the whole root text
      return [{
        role: "unknown",
        text: (chatRoot.innerText || "").trim(),
        html: "",
        model: ""
      }];
    }

    const messages = [];
    const seen = new Set();

    for (const el of msgEls) {
      const isBot  = el.getAttribute("data-msg-isbot");
      const role   = isBot === "1" ? "assistant" : isBot === "0" ? "user" : "unknown";
      const model  = role === "assistant" ? extractModelName(el) : "";
      const { html, text } = extractMessageContent(el);

      if (!text) continue;

      // Deduplicate by content fingerprint
      const sig = `${role}:${text.slice(0, 200)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      messages.push({ role, text, html, model: model || null });
    }

    return messages;
  }

  /* ── Assemble a conversation record ─────────────────────────────────── */

  function buildRecord(item, messages) {
    // Pick the first non-empty model name from assistant messages
    const model = messages.find(m => m.model)?.model || null;
    // Strip internal model field from each message (hoisted to conversation level)
    const cleanMsgs = messages.map(({ role, text, html }) => ({ role, text, html }));

    return {
      conversationId: item.conversationId,
      title:          item.title || item.conversationId,
      section:        MODE,
      projectId:      null,
      projectName:    null,
      capturedAt:     now(),
      model,
      messageCount:   cleanMsgs.length,
      messages:       cleanMsgs,
    };
  }

  /* ══════════════════════════════ MAIN ═══════════════════════════════════ */

  const badge = makeBadge();

  try {
    const appId = urlParam("appId");
    if (!appId) {
      badge.warn("⚠ No appId in URL — export will still work but URLs won't be stored.");
    }

    /* 1. Collect sidebar rows */
    badge.set("Scrolling sidebar to collect chats…");
    const allRows = await collectAllRows();
    const rows = allRows.slice(0, MAX_CHATS === Infinity ? undefined : MAX_CHATS);

    if (!rows.length) {
      badge.err("No chat rows found.\nMake sure [data-id=\"containerFiltered\"] is visible.");
      return;
    }
    badge.set(`Found ${rows.length} chats. Starting capture…`);

    const conversations = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      badge.set(`[${i + 1}/${rows.length}] ${row.title}`);

      const isFirst = i === 0;
      const prevSig = chatSig();

      if (isFirst && FIRST_CHAT_ALREADY_OPEN) {
        // The first chat is already rendered — capture immediately, no click needed
        await waitForStable(prevSig + "_force_capture", row.conversationId);
      } else {
        // Click the row and wait for a genuine DOM change
        humanClick(row.node);
        await waitForStable(prevSig, row.conversationId);
      }

      const chatRoot = qs("#scroll-helper-bottom");
      if (!chatRoot) {
        console.warn("[abacus-export] #scroll-helper-bottom not found for", row.conversationId);
        conversations.push(buildRecord(row, []));
        await sleep(BETWEEN_CHATS_SEC * 1000);
        continue;
      }

      const messages = extractMessages(chatRoot, row.conversationId);
      conversations.push(buildRecord(row, messages));

      await sleep(BETWEEN_CHATS_SEC * 1000);
    }

    /* 2. Build output */
    const payload = {
      schemaVersion: "2.0",
      source:        "abacus-chatllm",
      exportedAt:    now(),
      mode:          MODE,
      conversations,
    };

    const filename = MODE === "projects"
      ? "abacus-export-projects.json"
      : "abacus-export-chats.json";

    download(payload, filename);
    window.__abacusLastExport = payload;

    const withMsgs = conversations.filter(c => c.messageCount > 0).length;
    badge.ok(`✓ Done. ${withMsgs}/${conversations.length} chats captured.\nDownloaded: ${filename}`);
    badge.gone(12000);

  } catch (err) {
    console.error("[abacus-export]", err);
    badge.err(`Export failed:\n${err?.message || err}`);
    badge.gone(15000);
  }

})();
