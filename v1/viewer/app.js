const state = {
  conversations: [],
  filtered: [],
  selectedKey: null,
  showRaw: false,
  projectFolderOpen: false,
  projectOpenMap: new Map(),
};

const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const messagesEl = document.getElementById("messages");
const statsEl = document.getElementById("stats");
const metaEl = document.getElementById("meta");
const toggleRawBtn = document.getElementById("toggleRaw");
const msgTemplate = document.getElementById("message-template");
const loadControls = document.getElementById("loadControls");
const loadJsonBtn = document.getElementById("loadJson");
const fileInput = document.getElementById("fileInput");
const contentEl = document.querySelector(".content");
const contentHeaderEl = document.querySelector(".content-header");
let hoveredCodeBlock = null;
const codeBlockMap = new WeakMap();

const ALLOWED_TAGS = new Set([
  "div",
  "span",
  "p",
  "strong",
  "em",
  "code",
  "pre",
  "br",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "img",
  "a",
]);

const DROP_TAGS = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "svg"]);

const ALLOWED_ATTRS = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title"],
  code: ["class"],
  pre: ["class"],
  span: ["class"],
};

function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const walk = (node) => {
    const children = Array.from(node.children);
    for (const child of children) {
      const tag = child.tagName.toLowerCase();

      if (DROP_TAGS.has(tag)) {
        child.remove();
        continue;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        const frag = document.createDocumentFragment();
        while (child.firstChild) frag.appendChild(child.firstChild);
        child.replaceWith(frag);
        continue;
      }

      const allowedAttrs = ALLOWED_ATTRS[tag] || [];
      for (const attr of Array.from(child.attributes)) {
        if (!allowedAttrs.includes(attr.name)) child.removeAttribute(attr.name);
      }

      if (tag === "a") {
        const href = child.getAttribute("href") || "";
        if (!href.startsWith("http")) child.removeAttribute("href");
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }

      walk(child);
    }
  };

  walk(template.content);
  return template.innerHTML;
}

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  };
  return String(text || "").replace(/[&<>"']/g, (m) => map[m]);
}

function basicHighlight(code, language) {
  const lang = (language || "text").toLowerCase();
  let html = escapeHtml(code);

  const stringRegex = /(\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')/g;
  const commentRegex = /(#.*$|\/\/.*$)/gm;

  const tokens = [];
  html = html.replace(stringRegex, (match) => {
    const idx = tokens.length;
    tokens.push({ type: "string", value: match });
    return `__STRING_${idx}__`;
  });

  html = html.replace(commentRegex, (match) => {
    const idx = tokens.length;
    tokens.push({ type: "comment", value: match });
    return `__COMMENT_${idx}__`;
  });

  if (lang === "python" || lang === "py") {
    html = html.replace(/\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|yield|lambda|pass|in|is|and|or|not|global|nonlocal|assert|async|await)\b/g, "<span class=\"hljs-keyword\">$1</span>");
    html = html.replace(/\b(True|False|None)\b/g, "<span class=\"hljs-literal\">$1</span>");
  } else if (lang === "javascript" || lang === "js" || lang === "typescript" || lang === "ts") {
    html = html.replace(/\b(function|return|if|else|for|while|break|continue|import|from|export|default|const|let|var|class|new|try|catch|finally|throw|async|await|switch|case|typeof|instanceof|in|of)\b/g, "<span class=\"hljs-keyword\">$1</span>");
    html = html.replace(/\b(true|false|null|undefined)\b/g, "<span class=\"hljs-literal\">$1</span>");
  } else if (lang === "json") {
    html = html.replace(/\b(true|false|null)\b/g, "<span class=\"hljs-literal\">$1</span>");
  } else if (lang === "bash" || lang === "sh" || lang === "shell") {
    html = html.replace(/\b(if|then|else|fi|for|in|do|done|case|esac|while|function)\b/g, "<span class=\"hljs-keyword\">$1</span>");
  }

  html = html.replace(/\b(0x[a-fA-F0-9]+|\\d+(?:\\.\\d+)?)\b/g, "<span class=\"hljs-number\">$1</span>");

  html = html.replace(/__STRING_(\\d+)__/g, (_, idx) => `<span class=\"hljs-string\">${tokens[idx].value}</span>`);
  html = html.replace(/__COMMENT_(\\d+)__/g, (_, idx) => `<span class=\"hljs-comment\">${tokens[idx].value}</span>`);

  return html;
}

function formatTimestampParts(ts) {
  if (!ts) return { date: "", time: "" };
  try {
    const dateObj = new Date(ts);
    if (Number.isNaN(dateObj.getTime())) return { date: String(ts), time: "" };
    const date = dateObj.toLocaleDateString(undefined, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    const time = dateObj.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return { date, time };
  } catch {
    return { date: String(ts), time: "" };
  }
}

function formatDateOnly(ts) {
  if (!ts) return "";
  try {
    const dateObj = new Date(ts);
    if (Number.isNaN(dateObj.getTime())) return String(ts);
    return dateObj.toLocaleDateString();
  } catch {
    return String(ts);
  }
}

function getMessageContent(msg) {
  return msg.text || msg.html || "";
}

function isProbablyHtml(msg) {
  if (!msg || !msg.html) return false;
  if (msg.html === msg.text) return false;
  return /<\/?[a-z][\s\S]*>/i.test(msg.html);
}

function buildSearchText(conv) {
  if (conv.searchText) return conv.searchText.toLowerCase();
  if (!Array.isArray(conv.messages)) return "";
  const projectHint = conv.projectName ? ` ${conv.projectName}` : "";
  return (projectHint + " " + conv.messages.map(m => m.text || "").join(" ")).toLowerCase();
}

function getConversationKey(conv) {
  const section = conv.section || "chats";
  return `${section}:${conv.conversationId}`;
}

function groupProjects(conversations) {
  const map = new Map();
  for (const conv of conversations) {
    if (conv.section !== "projects") continue;
    const projectId = conv.projectId || "unknown";
    const projectName = conv.projectName || `Project ${projectId}`;
    if (!map.has(projectId)) {
      map.set(projectId, { projectId, projectName, chats: [] });
    }
    map.get(projectId).chats.push(conv);
  }

  const groups = Array.from(map.values());
  groups.sort((a, b) => a.projectName.localeCompare(b.projectName));
  for (const group of groups) {
    group.chats.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
  }
  return groups;
}

function createChatListItem(conv, extraClass) {
  const item = document.createElement("div");
  item.className = "list-item" + (extraClass ? ` ${extraClass}` : "") + (getConversationKey(conv) === state.selectedKey ? " active" : "");
  item.dataset.id = conv.conversationId;

  const title = document.createElement("div");
  title.className = "list-title";
  title.textContent = conv.title || `Conversation ${conv.conversationId}`;

  const subtitle = document.createElement("div");
  subtitle.className = "list-subtitle";
  const metaBits = [`${conv.messageCount || 0} messages`];
  if (conv.projectName || conv.projectId) {
    metaBits.push(`Project: ${conv.projectName || conv.projectId}`);
  } else if (conv.section && conv.section !== "chats") {
    metaBits.push(conv.section);
  }
  subtitle.textContent = metaBits.join(" • ");

  item.appendChild(title);
  item.appendChild(subtitle);

  item.addEventListener("click", () => {
    state.selectedKey = getConversationKey(conv);
    render();
  });

  return item;
}

function renderList() {
  listEl.innerHTML = "";
  const fragment = document.createDocumentFragment();

  if (!Array.isArray(state.filtered)) {
    state.filtered = [];
  }

  const projects = groupProjects(state.filtered);
  if (projects.length) {
    const folder = document.createElement("div");
    folder.className = "list-folder";
    folder.textContent = state.projectFolderOpen ? "Projects ▾" : "Projects ▸";
    folder.addEventListener("click", () => {
      state.projectFolderOpen = !state.projectFolderOpen;
      renderList();
    });
    fragment.appendChild(folder);

    if (state.projectFolderOpen) {
      for (const project of projects) {
        const projectItem = document.createElement("div");
        projectItem.className = "list-item list-project" + (state.projectOpenMap.get(project.projectId) ? " open" : "");
        projectItem.textContent = `${project.projectName} (${project.chats.length})`;
        projectItem.addEventListener("click", (event) => {
          event.stopPropagation();
          const current = state.projectOpenMap.get(project.projectId);
          state.projectOpenMap.set(project.projectId, !current);
          renderList();
        });
        fragment.appendChild(projectItem);

        if (state.projectOpenMap.get(project.projectId)) {
          for (const conv of project.chats) {
            fragment.appendChild(createChatListItem(conv, "list-chat"));
          }
        }
      }
    }
  }

  const regularChats = state.filtered.filter(conv => conv.section !== "projects");
  for (const conv of regularChats) {
    fragment.appendChild(createChatListItem(conv));
  }

  listEl.appendChild(fragment);
}

function renderMessages(conv) {
  messagesEl.innerHTML = "";

  if (!conv) {
    messagesEl.textContent = "Select a conversation to see messages.";
    return;
  }

  if (state.showRaw) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(conv, null, 2);
    messagesEl.appendChild(pre);
    return;
  }

  if (!Array.isArray(conv.messages) || conv.messages.length === 0) {
    messagesEl.textContent = "No messages found in this conversation.";
    return;
  }

  const fragment = document.createDocumentFragment();

  const convModel =
    conv.model ||
    (Array.isArray(conv.messages)
      ? conv.messages.find(m => m.model)?.model
      : null);

  for (const msg of conv.messages) {
    const node = msgTemplate.content.cloneNode(true);
    const article = node.querySelector(".message");
    const roleEl = node.querySelector(".role");
    const tsEl = node.querySelector(".timestamp");
    const modelEl = node.querySelector(".model");
    const bodyEl = node.querySelector(".message-body");

    const role = msg.role || "unknown";
    article.classList.add(role);
    const model = msg.model || convModel || conv.model || null;
    const roleLabel =
      role === "assistant" ? "Assistant" :
      role === "user" ? "User" :
      role === "system" ? "System" :
      "Unknown";
    roleEl.textContent = model && role === "assistant"
      ? `${roleLabel} (${model})`
      : roleLabel;
    const parts = formatTimestampParts(msg.timestamp);
    tsEl.textContent = parts.date && parts.time ? `${parts.date} • ${parts.time}` : parts.date || parts.time || "";
    modelEl.textContent = "";

    const content = getMessageContent(msg);
    bodyEl.classList.remove("plain");

    if (isProbablyHtml(msg)) {
      bodyEl.innerHTML = sanitizeHtml(msg.html);
    } else if (window.marked) {
      const markdownHtml = window.marked.parse(content || "", { breaks: true, gfm: true });
      bodyEl.innerHTML = sanitizeHtml(markdownHtml);
    } else {
      bodyEl.classList.add("plain");
      bodyEl.innerHTML = sanitizeHtml(escapeHtml(content));
    }

    enhanceCodeBlocks(bodyEl);

    const thinkingText =
      msg.thinking ||
      msg.reasoning ||
      msg.thoughts ||
      msg.thought ||
      msg.chainOfThought ||
      null;

    if (thinkingText) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "thinking-toggle";
      toggle.textContent = "Thinking ▸";

      const panel = document.createElement("div");
      panel.className = "thinking-panel";
      panel.textContent = String(thinkingText);
      panel.hidden = true;

      toggle.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        toggle.textContent = panel.hidden ? "Thinking ▸" : "Thinking ▾";
      });

      const metaRow = node.querySelector(".message-meta");
      if (metaRow) metaRow.appendChild(toggle);
      bodyEl.prepend(panel);
    }

    fragment.appendChild(node);
  }

  messagesEl.appendChild(fragment);
  applySyntaxHighlighting(messagesEl);

  requestAnimationFrame(() => {
    layoutMessagesPane();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    setTimeout(() => {
      layoutMessagesPane();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 0);
  });
}

function render() {
  renderList();

  const conv = state.conversations.find(c => getConversationKey(c) === state.selectedKey);
  if (conv) {
    const model =
      conv.model ||
      (Array.isArray(conv.messages)
        ? conv.messages.find(m => m.model)?.model
        : null);
    titleEl.textContent = conv.title || `Conversation ${conv.conversationId}`;
    const convDate =
      (Array.isArray(conv.messages) && conv.messages.length
        ? formatDateOnly(conv.messages[0].timestamp)
        : formatDateOnly(conv.capturedAt));
    const messageCount = conv.messageCount || (Array.isArray(conv.messages) ? conv.messages.length : 0);
    subtitleEl.innerHTML = `
      <span class="meta-item">${convDate || ""}</span>
      <span class="meta-dot">•</span>
      <span class="meta-item">${messageCount} messages</span>
    `.trim();
  } else {
    titleEl.textContent = "Select a conversation";
    subtitleEl.textContent = "";
  }

  renderMessages(conv);
}

function applyFilter(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    state.filtered = [...state.conversations];
    return;
  }

  state.filtered = state.conversations.filter(conv => {
    const title = (conv.title || "").toLowerCase();
    const search = conv._search || "";
    return title.includes(q) || search.includes(q);
  });
}

function applyData(data) {
  if (loadControls) loadControls.classList.remove("visible");
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  const projectNameMap = new Map();
  if (Array.isArray(data.projects)) {
    for (const project of data.projects) {
      if (!project) continue;
      const projectId = project.chatllmProjectId || project.projectId;
      if (!projectId) continue;
      const name = project.name || project.projectName || "";
      if (name) projectNameMap.set(String(projectId), name);
    }
  }

  for (const conv of conversations) {
    if (conv?.section === "projects" && !conv.projectName && conv.projectId) {
      const mapped = projectNameMap.get(String(conv.projectId));
      if (mapped) conv.projectName = mapped;
    }
    conv._search = buildSearchText(conv);
  }

  state.conversations = conversations;
  state.filtered = [...conversations];

  const totalMessages = conversations.reduce((sum, c) => sum + (c.messageCount || 0), 0);
  statsEl.textContent = `${conversations.length} conversations • ${totalMessages} messages • schema ${data.schemaVersion || "?"}`;
  metaEl.textContent = data.exportedAt ? `Exported ${new Date(data.exportedAt).toLocaleString()}` : "";

  if (conversations.length) {
    state.selectedKey = getConversationKey(conversations[0]);
  }

  render();
}

async function fetchJson(path) {
  const cacheBuster = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${cacheBuster}t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

async function loadJsonFromPaths(paths) {
  for (const path of paths) {
    try {
      const data = await fetchJson(path);
      if (data) return data;
    } catch {
      // continue to next path
    }
  }
  return null;
}

function mergeExports(base, extra) {
  const buildProjectNameMap = (data) => {
    const map = new Map();
    if (!data || !Array.isArray(data.projects)) return map;
    for (const project of data.projects) {
      if (!project) continue;
      const projectId = project.chatllmProjectId || project.projectId;
      if (!projectId) continue;
      const name = project.name || project.projectName || "";
      if (name) map.set(String(projectId), name);
    }
    return map;
  };

  const projectNameMap = new Map();
  for (const [id, name] of buildProjectNameMap(base)) projectNameMap.set(id, name);
  for (const [id, name] of buildProjectNameMap(extra)) projectNameMap.set(id, name);

  const merged = {
    schemaVersion: base.schemaVersion || extra.schemaVersion || "1.0",
    source: base.source || extra.source || "abacus-chatllm",
    exportedAt: base.exportedAt || extra.exportedAt || null,
    mode: base.mode || extra.mode || "merged",
    appId: base.appId || extra.appId || null,
    deploymentId: base.deploymentId || extra.deploymentId || null,
    conversations: [],
  };

  const map = new Map();
  const baseDefaultSection = base.mode === "projects" ? "projects" : "chats";
  const extraDefaultSection = extra.mode === "projects" ? "projects" : "chats";

  const addConvs = (convs, fallbackSection) => {
    if (!Array.isArray(convs)) return;
    for (const conv of convs) {
      const section = conv.section || fallbackSection;
      const key = `${section}:${conv.conversationId}`;
      if (!map.has(key)) map.set(key, conv);
    }
  };

  addConvs(base.conversations, baseDefaultSection);
  addConvs(extra.conversations, extraDefaultSection);

  merged.conversations = Array.from(map.values()).map(conv => {
    if (conv?.section === "projects" && !conv.projectName && conv.projectId) {
      const mapped = projectNameMap.get(String(conv.projectId));
      if (mapped) {
        return { ...conv, projectName: mapped };
      }
    }
    return conv;
  });
  return merged;
}

async function loadData() {
  const paths = [
    "../out/abacus-chats.json",
    "/v1/out/abacus-chats.json",
    "/out/abacus-chats.json",
    "./abacus-chats.json",
  ];
  const projectPaths = [
    "../out/abacus-project-chats.json",
    "/v1/out/abacus-project-chats.json",
    "/out/abacus-project-chats.json",
    "./abacus-project-chats.json",
  ];

  try {
    let baseData = null;
    let projectData = null;
    let baseError = null;
    let projectError = null;

    try {
      baseData = await loadJsonFromPaths(paths);
    } catch (err) {
      baseError = err;
    }

    try {
      projectData = await loadJsonFromPaths(projectPaths);
    } catch (err) {
      projectError = err;
    }

    if (baseData && projectData) {
      applyData(mergeExports(baseData, projectData));
      return;
    }

    if (baseData) {
      applyData(baseData);
      return;
    }

    if (projectData) {
      applyData(projectData);
      return;
    }

    throw baseError || projectError || new Error("No default JSON path worked.");
  } catch (err) {
    statsEl.textContent = "Failed to load export JSON.";
    messagesEl.textContent = err.message || "Error";
    loadControls.classList.add("visible");
  }
}

searchEl.addEventListener("input", (e) => {
  applyFilter(e.target.value);
  render();
});

toggleRawBtn.addEventListener("click", () => {
  state.showRaw = !state.showRaw;
  toggleRawBtn.textContent = state.showRaw ? "Show Rendered" : "Toggle Raw";
  render();
});

loadJsonBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      loadControls.classList.remove("visible");
      applyData(data);
    } catch (err) {
      statsEl.textContent = "Failed to parse JSON file.";
      messagesEl.textContent = err.message || "Error";
      loadControls.classList.add("visible");
    }
  };
  reader.readAsText(file);
});

loadData();

function layoutMessagesPane() {
  if (!contentEl || !contentHeaderEl || !messagesEl) return;
  const contentRect = contentEl.getBoundingClientRect();
  const headerRect = contentHeaderEl.getBoundingClientRect();
  const gap = 16;
  const bottomPadding = 24;
  const top = headerRect.bottom - contentRect.top + gap;
  const height = contentRect.height - top - bottomPadding;

  if (height > 0) {
    messagesEl.style.top = `${top}px`;
    messagesEl.style.bottom = `${bottomPadding}px`;
    messagesEl.style.height = `${height}px`;
  }
}

window.addEventListener("resize", () => {
  layoutMessagesPane();
});

if (window.marked) {
  window.marked.setOptions({
    breaks: true,
    gfm: true,
    langPrefix: "language-",
    highlight: (code, lang) => {
      if (!window.hljs) return code;
      if (lang && window.hljs.getLanguage(lang)) {
        return window.hljs.highlight(code, { language: lang }).value;
      }
      return window.hljs.highlightAuto(code).value;
    },
  });
}
function enhanceCodeBlocks(container) {
  if (!container) return;
  const blocks = Array.from(container.querySelectorAll("pre > code"));
  for (const codeEl of blocks) {
    const pre = codeEl.parentElement;
    if (!pre || pre.dataset.enhanced === "true") continue;
    pre.dataset.enhanced = "true";

    const className = codeEl.className || "";
    const match = className.match(/language-([a-z0-9_-]+)/i);
    const language = match ? match[1].toLowerCase() : "text";

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";

    const header = document.createElement("div");
    header.className = "code-block-header";

    const langEl = document.createElement("span");
    langEl.className = "code-lang";
    langEl.textContent = language;

    const copyBtn = document.createElement("button");
    copyBtn.className = "code-copy";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";

    const flashCopy = (label) => {
      copyBtn.textContent = label;
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 1200);
    };

    const copyCode = async () => {
      try {
        await navigator.clipboard.writeText(codeEl.textContent || "");
        flashCopy("Copied");
      } catch {
        flashCopy("Failed");
      }
    };

    copyBtn.addEventListener("click", copyCode);

    header.appendChild(langEl);
    header.appendChild(copyBtn);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);

    codeEl.classList.add("hljs");

    codeBlockMap.set(wrapper, { codeEl, copyBtn, copyCode });
    wrapper.addEventListener("mouseenter", () => {
      hoveredCodeBlock = wrapper;
    });
    wrapper.addEventListener("mouseleave", () => {
      if (hoveredCodeBlock === wrapper) hoveredCodeBlock = null;
    });
  }
}

function applySyntaxHighlighting(container) {
  if (!container) return;
  container.querySelectorAll("pre > code").forEach(codeEl => {
    if (!codeEl.classList.contains("hljs")) codeEl.classList.add("hljs");
    if (codeEl.dataset.highlighted) return;

    const className = codeEl.className || "";
    const match = className.match(/language-([a-z0-9_-]+)/i);
    const language = match ? match[1].toLowerCase() : "text";
    const fallbackLanguages = new Set(["python", "py", "javascript", "js", "typescript", "ts", "json", "bash", "sh", "shell"]);

    if (fallbackLanguages.has(language)) {
      codeEl.innerHTML = basicHighlight(codeEl.textContent || "", language);
      codeEl.dataset.highlighted = "yes";
      return;
    }

    let needsFallback = false;
    if (window.hljs) {
      window.hljs.highlightElement(codeEl);
      if (!codeEl.querySelector("span")) {
        needsFallback = true;
      }
    }

    if (!window.hljs || needsFallback) {
      codeEl.innerHTML = basicHighlight(codeEl.textContent || "", language);
    }

    codeEl.dataset.highlighted = "yes";
  });
}

document.addEventListener("keydown", (event) => {
  if (!hoveredCodeBlock) return;
  if (!event.metaKey || event.key.toLowerCase() !== "c") return;
  const data = codeBlockMap.get(hoveredCodeBlock);
  if (!data) return;
  event.preventDefault();
  data.copyCode();
});
