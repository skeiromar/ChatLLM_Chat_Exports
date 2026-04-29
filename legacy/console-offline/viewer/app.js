/* Abacus Chat Archive Viewer — app.js */
(function () {
"use strict";

/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  conversations: [],   // all conversations (merged from all loaded files)
  filtered: [],        // after search + project filter
  selectedId: null,
  search: "",
  projectFilter: null, // null = all
};

/* ── DOM refs ───────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const sidebar         = document.querySelector(".sidebar");
const sidebarToggle   = $("sidebarToggle");
const mobileSidebarBtn= $("mobileSidebarBtn");
const statsLabel      = $("statsLabel");
const searchInput     = $("searchInput");
const projectFilters  = $("projectFilters");
const projectConvos   = $("projectConversations");
const chatConvos      = $("chatConversations");
const dropZone        = $("dropZone");
const metaBar         = $("metaBar");
const convPane        = $("conversationPane");
const convTitle       = $("conversationTitle");
const fileInput       = $("fileInput");
const projectsHeader  = $("projectsHeader");
const chatsHeader     = $("chatsHeader");

/* ── Markdown renderer setup ────────────────────────────────────────── */
// Configure marked.js for safe, readable output
if (window.marked) {
  marked.setOptions({
    gfm: true,
    breaks: true,
    mangle: false,
    headerIds: false,
  });
}

// Re-insert newlines before markdown structure markers when the old exporter
// collapsed everything to one line (safeText() stripped all \n).
function normalizeCollapsedMarkdown(text) {
  if (!text) return text;
  if (text.includes('\n')) return text; // already structured, leave alone

  let out = text;
  // Insert blank line before headings:   "… ### Foo" → "…\n\n### Foo"
  out = out.replace(/ (#{1,6}) ([A-Z*"'`\-\[])/g, '\n\n$1 $2');
  // Insert newline before numbered list items: " 1. " " 2. " etc.
  out = out.replace(/ (\d{1,2})\. ([A-Z"'`\-\[])/g, '\n$1. $2');
  // Insert newline before dash-bullet list items: " - Foo"
  out = out.replace(/ - ([A-Z"'`\*\[])/g, '\n- $1');
  // Insert newline before bold section headers: " **Foo:**" or " **Foo Bar:**"
  out = out.replace(/ (\*\*[A-Z][^*]{2,40}\*\*[: ])/g, '\n\n$1');
  return out;
}

function renderMarkdown(text) {
  if (!text) return "";
  const normalized = normalizeCollapsedMarkdown(text);
  if (window.marked) {
    try { return marked.parse(normalized); } catch (e) { /* fall through */ }
  }
  // Fallback: escape HTML and wrap in pre
  return "<pre>" + normalized.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</pre>";
}

/* ── Detect if content is already rendered HTML or raw markdown ─────── */
function isRenderedHtml(str) {
  // Contains actual semantic HTML tags (not just escaped text)
  return /<(p|h[1-6]|ul|ol|li|pre|code|blockquote|table|strong|em|a\s|div|span)\b/i.test(str);
}

/* ── Safe HTML sanitization (keep semantic structure, ditch scripts) ── */
function sanitize(html) {
  const t = document.createElement("template");
  t.innerHTML = html || "";
  const bad = ["script","style","iframe","object","embed","link","meta","noscript"];
  t.content.querySelectorAll(bad.join(",")).forEach(e => e.remove());
  // Remove all on* event attributes
  const walker = document.createTreeWalker(t.content, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    for (const attr of [...(node.attributes || [])]) {
      if (attr.name.toLowerCase().startsWith("on")) node.removeAttribute(attr.name);
      // Remove javascript: hrefs
      if ((attr.name === "href" || attr.name === "src") && /^javascript:/i.test(attr.value))
        node.removeAttribute(attr.name);
    }
    node = walker.nextNode();
  }
  return t.innerHTML;
}

/* ── Build message HTML ─────────────────────────────────────────────── */
function buildMessageEl(msg, index) {
  const role = (msg.role || "unknown").toLowerCase();
  const div  = document.createElement("div");
  div.className = `message ${role}`;
  div.dataset.index = index;

  // Header: role pill + model badge
  const header = document.createElement("div");
  header.className = "message-header";

  const pill = document.createElement("span");
  pill.className = `role-pill ${role}`;
  pill.textContent = role === "user" ? "You" : role === "assistant" ? "Assistant" : "Unknown";
  header.appendChild(pill);

  const model = msg.model || "";
  if (model) {
    const badge = document.createElement("span");
    badge.className = "model-name";
    badge.textContent = model;
    header.appendChild(badge);
  }

  div.appendChild(header);

  // Thinking block (schema v2.0 has msg.thinking)
  if (msg.thinking) {
    const tb = document.createElement("div");
    tb.className = "thinking-block";

    const btn = document.createElement("button");
    btn.className = "thinking-toggle";
    btn.innerHTML = `<span class="arr">&#9658;</span> Thinking`;
    btn.onclick = () => {
      btn.classList.toggle("open");
      tc.classList.toggle("open");
    };
    tb.appendChild(btn);

    const tc = document.createElement("div");
    tc.className = "thinking-content";
    tc.textContent = msg.thinking;
    tb.appendChild(tc);

    div.appendChild(tb);
  }

  // Message content
  const content = document.createElement("div");
  content.className = "msg-content";

  const rawHtml = msg.html || "";
  const rawText = msg.text || msg.content || "";

  if (rawHtml && isRenderedHtml(rawHtml)) {
    // Already rendered HTML from Abacus DOM — sanitize and use directly
    content.innerHTML = sanitize(rawHtml);
  } else if (rawText) {
    // Plain text / markdown — render with marked.js
    content.innerHTML = renderMarkdown(rawText);
  } else if (rawHtml) {
    // HTML that might just be <pre> wrapping
    content.innerHTML = sanitize(rawHtml);
  }

  // Highlight code blocks and add copy buttons
  content.querySelectorAll("pre").forEach(pre => {
    // Add copy button
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.onclick = () => {
      const code = pre.querySelector("code") || pre;
      navigator.clipboard.writeText(code.textContent || "").then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("ok");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("ok"); }, 1500);
      });
    };
    pre.style.position = "relative";
    pre.appendChild(btn);

    // Syntax highlighting
    if (window.hljs) {
      const codeEl = pre.querySelector("code");
      if (codeEl) {
        try { hljs.highlightElement(codeEl); } catch(e) {}
      } else {
        // No <code> tag — wrap the text
        const text = pre.textContent || "";
        const codeWrap = document.createElement("code");
        codeWrap.textContent = text;
        pre.textContent = "";
        pre.appendChild(codeWrap);
        pre.appendChild(btn); // re-add copy button
        try { hljs.highlightElement(codeWrap); } catch(e) {}
      }
    }
  });

  div.appendChild(content);
  return div;
}

/* ── Render a conversation ──────────────────────────────────────────── */
function renderConversation(conv) {
  state.selectedId = conv.conversationId;

  // Update title
  convTitle.textContent = conv.title || conv.conversationId;

  // Meta bar
  const parts = [];
  if (conv.model)       parts.push(`<span class="meta-label">Model</span> ${conv.model}`);
  if (conv.messageCount) parts.push(`<span class="meta-label">Messages</span> ${conv.messageCount}`);
  if (conv.section)     parts.push(`<span class="meta-label">Section</span> ${conv.section}`);
  if (conv.projectName) parts.push(`<span class="meta-label">Project</span> ${conv.projectName}`);
  if (conv.capturedAt)  parts.push(`<span class="meta-label">Captured</span> ${new Date(conv.capturedAt).toLocaleDateString()}`);

  if (parts.length) {
    metaBar.innerHTML = parts.map(p => `<span class="meta-item">${p}</span>`).join("");
    metaBar.classList.remove("hidden");
  } else {
    metaBar.classList.add("hidden");
  }

  // Messages
  convPane.innerHTML = "";

  if (!conv.messages || conv.messages.length === 0) {
    convPane.innerHTML = `<div style="color:#9ca3af;text-align:center;margin-top:60px;font-size:14px">No messages captured for this conversation.</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < conv.messages.length; i++) {
    frag.appendChild(buildMessageEl(conv.messages[i], i));
  }
  convPane.appendChild(frag);

  // Highlight active sidebar item
  document.querySelectorAll(".conversation-list li").forEach(li => {
    li.classList.toggle("active", li.dataset.id === conv.conversationId);
  });

  // Scroll to top
  convPane.scrollTop = 0;
}

/* ── Sidebar list rendering ─────────────────────────────────────────── */
function buildListItem(conv) {
  const li = document.createElement("li");
  li.dataset.id = conv.conversationId;
  li.title = conv.title || conv.conversationId;

  const titleText = document.createTextNode(conv.title || conv.conversationId);
  li.appendChild(titleText);

  if (conv.model) {
    const modelSpan = document.createElement("span");
    modelSpan.className = "conv-model";
    modelSpan.textContent = conv.model;
    li.appendChild(modelSpan);
  }

  li.onclick = () => {
    const full = state.conversations.find(c => c.conversationId === conv.conversationId);
    if (full) renderConversation(full);
    // Close mobile sidebar
    if (window.innerWidth <= 768) sidebar.classList.remove("open");
  };

  return li;
}

function refreshSidebar() {
  const q = state.search.toLowerCase().trim();

  const match = conv => {
    if (state.projectFilter && state.projectFilter !== "__chats__") {
      if (conv.projectName !== state.projectFilter && conv.projectId !== state.projectFilter) return false;
    }
    if (state.projectFilter === "__chats__" && conv.section === "projects") return false;
    if (!q) return true;
    const hay = ((conv.title || "") + " " + (conv.searchText || "") +
                  (conv.messages || []).map(m => m.text || m.content || "").join(" ")).toLowerCase();
    return hay.includes(q);
  };

  const projectConvList = state.conversations.filter(c => c.section === "projects" && match(c));
  const chatConvList    = state.conversations.filter(c => c.section !== "projects" && match(c));

  // Projects section
  projectsHeader.style.display = projectConvList.length ? "" : "none";
  projectConvos.innerHTML = "";
  for (const c of projectConvList) projectConvos.appendChild(buildListItem(c));

  // Chats section
  chatsHeader.style.display = chatConvList.length ? "" : "none";
  chatConvos.innerHTML = "";
  for (const c of chatConvList) chatConvos.appendChild(buildListItem(c));

  // Re-highlight active
  if (state.selectedId) {
    document.querySelectorAll(".conversation-list li").forEach(li => {
      li.classList.toggle("active", li.dataset.id === state.selectedId);
    });
  }

  state.filtered = [...projectConvList, ...chatConvList];
}

/* ── Project filter chips ───────────────────────────────────────────── */
function refreshProjectChips() {
  projectFilters.innerHTML = "";

  const allChip = document.createElement("span");
  allChip.className = "chip" + (!state.projectFilter ? " active" : "");
  allChip.textContent = "All";
  allChip.onclick = () => { state.projectFilter = null; refreshProjectChips(); refreshSidebar(); };
  projectFilters.appendChild(allChip);

  // "Chats only" chip
  const chatsChip = document.createElement("span");
  chatsChip.className = "chip" + (state.projectFilter === "__chats__" ? " active" : "");
  chatsChip.textContent = "Chats";
  chatsChip.onclick = () => { state.projectFilter = "__chats__"; refreshProjectChips(); refreshSidebar(); };
  projectFilters.appendChild(chatsChip);

  // One chip per project
  const projects = [...new Set(
    state.conversations
      .filter(c => c.section === "projects" && (c.projectName || c.projectId))
      .map(c => c.projectName || c.projectId)
  )];

  for (const proj of projects) {
    const chip = document.createElement("span");
    chip.className = "chip" + (state.projectFilter === proj ? " active" : "");
    chip.textContent = proj;
    chip.title = proj;
    chip.onclick = () => { state.projectFilter = proj; refreshProjectChips(); refreshSidebar(); };
    projectFilters.appendChild(chip);
  }
}

/* ── Data loading ───────────────────────────────────────────────────── */
function mergeConversations(incoming) {
  const byId = new Map(state.conversations.map(c => [c.conversationId, c]));

  for (const conv of incoming) {
    const existing = byId.get(conv.conversationId);
    // Keep the one with more messages (or newer capturedAt)
    if (!existing || (conv.messageCount || 0) >= (existing.messageCount || 0)) {
      byId.set(conv.conversationId, conv);
    }
  }

  // Sort: projects first, then by capturedAt desc, then title
  state.conversations = Array.from(byId.values()).sort((a, b) => {
    if (a.section !== b.section) return a.section === "projects" ? -1 : 1;
    const ta = a.capturedAt || ""; const tb = b.capturedAt || "";
    if (ta !== tb) return tb.localeCompare(ta);
    return (a.title || "").localeCompare(b.title || "");
  });
}

function loadJson(data) {
  let conversations = [];

  // Schema v2.0
  if (data.conversations && Array.isArray(data.conversations)) {
    conversations = data.conversations;
  }
  // Legacy: array at root
  else if (Array.isArray(data)) {
    conversations = data;
  }

  if (!conversations.length) {
    alert("No conversations found in this file.");
    return;
  }

  mergeConversations(conversations);

  const total  = state.conversations.length;
  const withMs = state.conversations.filter(c => (c.messageCount || 0) > 0).length;
  statsLabel.textContent = `${total} chats (${withMs} with messages)`;

  dropZone.classList.add("hidden");
  refreshProjectChips();
  refreshSidebar();

  // Auto-select first conversation that has messages
  const first = state.conversations.find(c => (c.messageCount || 0) > 0);
  if (first && !state.selectedId) renderConversation(first);
}

async function handleFiles(files) {
  for (const file of files) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      loadJson(data);
    } catch (e) {
      alert(`Could not parse ${file.name}: ${e.message}`);
    }
  }
}

/* ── Auto-load clean-archive.json if served locally ─────────────────── */
async function tryAutoLoad() {
  const candidates = [
    "../clean-archive.json",
    "./clean-archive.json",
    "../abacus-export-bundle.json",
    "../abacus-export-chats.json"
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.conversations) { loadJson(data); return; }
    } catch (e) { /* not found */ }
  }
}

/* ── Events ─────────────────────────────────────────────────────────── */
sidebarToggle.onclick = () => sidebar.classList.toggle("collapsed");
mobileSidebarBtn.onclick = () => sidebar.classList.toggle("open");

searchInput.oninput = () => {
  state.search = searchInput.value;
  refreshSidebar();
};

fileInput.onchange = e => handleFiles(e.target.files);

// Drag-and-drop
const mainPane = document.querySelector(".main-pane");
mainPane.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
mainPane.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
mainPane.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

// Keyboard shortcut: / to focus search
document.addEventListener("keydown", e => {
  if (e.key === "/" && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
  if (e.key === "Escape") searchInput.blur();
});

/* ── Init ───────────────────────────────────────────────────────────── */
tryAutoLoad();

})();
