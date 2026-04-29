#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const RESOURCES_DIR = path.join(PROJECT_ROOT, "resources");

const DEFAULT_OUT_DIR = path.join(SCRIPT_DIR, "out");
const DEFAULT_OUT_FILE = path.join(DEFAULT_OUT_DIR, "abacus-chats.json");
const DEFAULT_LOCALSTORAGE_PATH = path.join(RESOURCES_DIR, "localStorage_dump.json");
const DEFAULT_COOKIES_PATHS = [
  path.join(SCRIPT_DIR, "cookies.txt"),
  path.join(RESOURCES_DIR, "cookies.txt"),
  path.join(SCRIPT_DIR, "cookies.json"),
  path.join(RESOURCES_DIR, "cookies.json"),
];

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_COOKIE_ALLOW = ["_s_p", "_u_p", "_a_p", "_ss_p"];
const MAX_COOKIE_HEADER_LEN = 7000;
const MODEL_MAP = {
  // OpenAI GPT models
  OPENAI_GPT5_4: "GPT-5.4",
  OPENAI_GPT5_3_INSTANT: "GPT-5.3 Instant",
  OPENAI_GPT5_3: "GPT-5.3",
  OPENAI_GPT5_2: "GPT-5.2",
  OPENAI_GPT5: "GPT-5",
  OPENAI_GPT4_TURBO: "GPT-4 Turbo",
  OPENAI_GPT4: "GPT-4",

  // Anthropic Claude models
  CLAUDE_V4_6_OPUS: "Claude 4.6 Opus",
  CLAUDE_V4_5_OPUS: "Claude 4.5 Opus",
  CLAUDE_V4_5_SONNET: "Claude 4.5 Sonnet",
  CLAUDE_V4_5_HAIKU: "Claude 4.5 Haiku",
  CLAUDE_V3_5_SONNET: "Claude 3.5 Sonnet",
  CLAUDE_V3_OPUS: "Claude 3 Opus",

  // Google Gemini models
  GEMINI_3_1_PRO: "Gemini 3.1 Pro",
  GEMINI_3_FLASH: "Gemini 3 Flash",
  GEMINI_3_PRO: "Gemini 3 Pro",
  GEMINI_2_FLASH: "Gemini 2 Flash",
  GEMINI_2_PRO: "Gemini 2 Pro",

  // DeepSeek models
  DEEPSEEK_R1: "DeepSeek R1",
  DEEPSEEK_V2_5: "DeepSeek V2.5",

  // xAI Grok models
  GROK_3: "Grok 3",
  GROK_2: "Grok 2",
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function findFirstExisting(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return null;
  }
}

function isAbacusDomain(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return d === "abacus.ai" || d.endsWith(".abacus.ai");
}

function normalizeCookieHeader(raw) {
  const cleaned = raw
    .replace(/\r?\n/g, "; ")
    .replace(/;\s*;/g, ";")
    .trim();
  return cleaned.endsWith(";") ? cleaned.slice(0, -1).trim() : cleaned;
}

function cookieArrayToHeader(cookies) {
  const parts = [];
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const name = String(c.name).trim();
    const value = c.value == null ? "" : String(c.value).trim();
    if (!name) continue;
    parts.push(`${name}=${value}`);
  }
  return normalizeCookieHeader(parts.join("; "));
}

function filterCookiesByName(cookies, allowList) {
  if (!Array.isArray(cookies) || !allowList?.length) return cookies;
  const allowed = new Set(allowList.map(name => name.trim()).filter(Boolean));
  return cookies.filter(c => allowed.has(String(c.name || "").trim()));
}

function parseCookiesFromRaw(raw) {
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.cookies)
        ? parsed.cookies
        : [];
    return arr.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || ".abacus.ai",
      path: c.path || "/",
    }));
  }

  if (raw.includes("=") && !raw.startsWith("#")) {
    const cookies = [];
    for (const part of raw.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      const name = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (name) cookies.push({ name, value, domain: ".abacus.ai", path: "/" });
    }
    return cookies;
  }

  const cookies = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    cookies.push({
      domain: parts[0],
      name: parts[5],
      value: parts[6].trim(),
      path: parts[2] || "/",
    });
  }
  return cookies;
}

function loadCookieHeader(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return null;

  const mode = options.mode || "minimal";
  const allowList = options.allowList || DEFAULT_COOKIE_ALLOW;

  let cookies = parseCookiesFromRaw(raw);
  if (!cookies.length) return null;

  const abacusCookies = cookies.filter(c => isAbacusDomain(c.domain));
  cookies = abacusCookies.length ? abacusCookies : cookies;

  if (mode !== "all") {
    const filtered = filterCookiesByName(cookies, allowList);
    if (filtered.length) cookies = filtered;
  }

  let header = cookieArrayToHeader(cookies);
  if (header.length > MAX_COOKIE_HEADER_LEN) {
    const filtered = filterCookiesByName(cookies, allowList);
    const minimalHeader = cookieArrayToHeader(filtered);
    if (minimalHeader && minimalHeader.length < header.length) {
      header = minimalHeader;
    }
  }

  return header;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestJson(url, headers, timeoutMs, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      method: "GET",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers,
      agent,
    };

    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode} ${res.statusMessage || ""}`.trim());
          err.body = data.slice(0, 2000);
          err.statusCode = res.statusCode;
          err.url = url;
          return reject(err);
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          const parseErr = new Error("Failed to parse JSON response");
          parseErr.body = data.slice(0, 500);
          parseErr.url = url;
          reject(parseErr);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.end();
  });
}

async function safeRequestLite(url, headers, timeoutMs, agent) {
  try {
    const data = await requestJson(url, headers, timeoutMs, agent);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      body: err.body || null,
      url: err.url || url,
    };
  }
}

async function fetchLiteExtras({ headers, timeoutMs, agent, externalApplicationIds }) {
  const appsBase = "https://apps.abacus.ai/api";
  const extras = {
    listAllTasks: null,
    customInstructionsByExternalAppId: {},
    toolbarActionsByExternalAppId: {},
  };

  extras.listAllTasks = await safeRequestLite(`${appsBase}/_listAllTasks`, headers, timeoutMs, agent);

  for (const externalApplicationId of externalApplicationIds) {
    const qs = `externalApplicationId=${encodeURIComponent(externalApplicationId)}`;
    extras.customInstructionsByExternalAppId[externalApplicationId] = await safeRequestLite(
      `${appsBase}/_getCustomChatInstructions?${qs}`,
      headers,
      timeoutMs,
      agent
    );
    extras.toolbarActionsByExternalAppId[externalApplicationId] = await safeRequestLite(
      `${appsBase}/_fetchToolbarActions?${qs}`,
      headers,
      timeoutMs,
      agent
    );
  }

  return extras;
}

function normalizeRole(raw) {
  const role = (raw || "").toString().toUpperCase();
  if (role === "USER") return "user";
  if (role === "ASSISTANT" || role === "BOT") return "assistant";
  if (role === "SYSTEM") return "system";
  return "unknown";
}

function segmentsToText(segments) {
  if (!Array.isArray(segments) || !segments.length) return "";
  const out = [];
  for (const seg of segments) {
    if (!seg) continue;
    if (typeof seg === "string") {
      out.push(seg);
      continue;
    }

    const type = seg.type ? String(seg.type).toLowerCase() : "";
    if (type && type !== "text" && type !== "markdown") continue;

    let val = seg.segment ?? seg.text ?? seg.content ?? seg.markdown ?? "";
    if (val && typeof val === "object") {
      val = val.text ?? val.content ?? "";
    }

    if (typeof val === "string" && val) out.push(val);
  }

  return out.join("").trim();
}

function extractText(msg) {
  if (msg && typeof msg.text === "string" && msg.text.trim()) {
    return msg.text;
  }
  const segText = segmentsToText(msg?.segments);
  if (segText) return segText;

  if (Array.isArray(msg?.allVersions) && msg.allVersions.length) {
    const idx = Number.isInteger(msg.selectedVersionIndex) ? msg.selectedVersionIndex : 0;
    const ver = msg.allVersions[idx] || msg.allVersions[0];
    if (ver && typeof ver.text === "string" && ver.text.trim()) {
      return ver.text;
    }
    const verSegText = segmentsToText(ver?.segments);
    if (verSegText) return verSegText;
  }

  return "";
}

function mapModelName(rawName) {
  if (!rawName) return null;
  return MODEL_MAP[rawName] || rawName;
}

function extractModelRaw(msg) {
  if (msg?.llmName) return msg.llmName;
  if (msg?.inputParams?.llmName) return msg.inputParams.llmName;
  if (msg?.llmDisplayName) return msg.llmDisplayName;
  if (msg?.modelVersion) return msg.modelVersion;

  if (Array.isArray(msg?.allVersions) && msg.allVersions.length) {
    const idx = Number.isInteger(msg.selectedVersionIndex) ? msg.selectedVersionIndex : 0;
    const ver = msg.allVersions[idx] || msg.allVersions[0];
    return (
      ver?.llmName ||
      ver?.inputParams?.llmName ||
      ver?.llmDisplayName ||
      ver?.modelVersion ||
      null
    );
  }

  return null;
}

function extractModelDisplay(msg) {
  const raw = extractModelRaw(msg);
  if (raw && MODEL_MAP[raw]) return MODEL_MAP[raw];
  if (msg?.llmDisplayName) return msg.llmDisplayName;
  return raw;
}

function extractThinking(msg) {
  const direct = msg?.thinking || msg?.reasoning || msg?.thoughts || msg?.chainOfThought || msg?.thought || null;
  if (direct) return direct;
  if (Array.isArray(msg?.allVersions) && msg.allVersions.length) {
    const idx = Number.isInteger(msg.selectedVersionIndex) ? msg.selectedVersionIndex : 0;
    const ver = msg.allVersions[idx] || msg.allVersions[0];
    return ver?.thinking || ver?.reasoning || ver?.thoughts || ver?.chainOfThought || ver?.thought || null;
  }
  return null;
}

function buildMessageId(conversationId, msg) {
  const index = msg?.messageIndex != null ? msg.messageIndex : null;
  if (index == null) return `${conversationId}-m?`;
  return `${conversationId}-m${index}`;
}

function readIdsFile(filePath) {
  const data = loadJsonSafe(filePath);
  if (!data) return { items: [], mode: "chats" };

  if (Array.isArray(data)) {
    return {
      items: data.map(id => ({ id: String(id), title: "" })),
      mode: "chats",
    };
  }

  if (Array.isArray(data.ids)) {
    return {
      items: data.ids.map(entry => ({
        id: String(entry.id || entry.conversationId || entry),
        title: entry.title || "",
      })),
      mode: data.mode || "chats",
    };
  }

  if (Array.isArray(data.conversations)) {
    return {
      items: data.conversations.map(entry => ({
        id: String(entry.conversationId || entry.id),
        title: entry.title || "",
      })),
      mode: data.mode || "chats",
    };
  }

  return { items: [], mode: "chats" };
}

async function listConversations({ deploymentId, headers, listLimit, timeoutMs, agent }) {
  const params = new URLSearchParams({
    deploymentId,
    limit: String(listLimit),
  });
  const url = `https://apps.abacus.ai/api/listDeploymentConversations?${params.toString()}`;
  const data = await requestJson(url, headers, timeoutMs, agent);
  if (!data || data.success !== true) {
    throw new Error("listDeploymentConversations returned an error");
  }
  const result = Array.isArray(data.result) ? data.result : [];
  return result;
}

async function fetchConversation({
  deploymentId,
  conversationId,
  headers,
  messageLimit,
  timeoutMs,
  includeContext,
  includeAllVersions,
  agent,
}) {
  const params = new URLSearchParams({
    deploymentId,
    deploymentConversationId: conversationId,
    skipDocumentBoundingBoxes: "true",
    filterIntermediateConversationEvents: "false",
    limit: String(messageLimit),
    includeContext: includeContext ? "true" : "false",
    includeAllVersions: includeAllVersions ? "true" : "false",
  });
  const url = `https://apps.abacus.ai/api/getDeploymentConversation?${params.toString()}`;
  const data = await requestJson(url, headers, timeoutMs, agent);
  if (!data || data.success !== true) {
    throw new Error("getDeploymentConversation returned an error");
  }
  return data.result || {};
}

function buildConversationRecord({
  conversationId,
  title,
  history,
  capturedAt,
  includeSearchText,
  listEntry,
  appId,
  projectId,
  projectName,
}) {
  const messages = history.map(msg => {
    const text = extractText(msg);
    const role = normalizeRole(msg?.role);
    const modelRaw = extractModelRaw(msg);
    const modelDisplay = extractModelDisplay(msg);
    const thinking = extractThinking(msg);
    return {
      messageId: buildMessageId(conversationId, msg),
      role,
      timestamp: msg?.timestamp || null,
      messageIndex: msg?.messageIndex ?? null,
      text,
      content: text,
      html: text,
      modelRaw: modelRaw || null,
      modelDisplay: modelDisplay || null,
      model: modelDisplay || modelRaw || null,
      thinking: thinking || null,
    };
  });

  const messageCount = messages.length;
  const searchText = includeSearchText
    ? messages.map(m => m.text).join("\n\n")
    : "";

  return {
    conversationId,
    title,
    section: projectId ? "projects" : "chats",
    projectId: projectId || null,
    projectName: projectName || null,
    appId: appId || listEntry?.appId || null,
    deploymentId: listEntry?.deploymentId || null,
    externalApplicationId: listEntry?.externalApplicationId || null,
    conversationType: listEntry?.conversationType || null,
    hasHistory: listEntry?.hasHistory ?? null,
    createdAt: listEntry?.createdAt || null,
    lastEventAt: listEntry?.lastEventCreatedAt || null,
    metadata: listEntry?.metadata || null,
    capturedAt,
    modelRaw: messages.find(m => m.modelRaw)?.modelRaw || null,
    modelDisplay: messages.find(m => m.modelDisplay)?.modelDisplay || null,
    model: messages.find(m => m.model)?.model || null,
    messageCount,
    messages,
    searchText,
    rawHtml: "",
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  let schemaVersion = String(args.schema || "3.0-lite");
  if (schemaVersion !== "3.0-lite") {
    console.warn("⚠ Only schema 3.0-lite is supported for the unified export. Falling back to 3.0-lite.");
    schemaVersion = "3.0-lite";
  }
  const workers = Math.max(1, parseInt(args.workers || "6", 10));
  const MAX_LIST_LIMIT = 100000;
  let listLimit = Math.max(1, parseInt(args["list-limit"] || String(MAX_LIST_LIMIT), 10));
  const messageLimit = Math.max(1, parseInt(args["message-limit"] || "2000", 10));
  const delayMs = Math.max(0, parseInt(args["delay-ms"] || "0", 10));
  const timeoutMs = Math.max(1000, parseInt(args["timeout-ms"] || "30000", 10));
  const checkpointEvery = Math.max(1, parseInt(args["checkpoint-every"] || "25", 10));
  const resume = !!args.resume;
  const onlyNew = !!args["only-new"];
  const refetchAll = !!args["refetch-all"];
  const includeContext = !!args["include-context"];
  const includeAllVersions = args["include-all-versions"] !== "false";
  const includeSearchText = !args["no-search-text"];
  const limitConversations = args.limit ? Math.max(1, parseInt(args.limit, 10)) : Infinity;

  const outFile = path.resolve(args.out || DEFAULT_OUT_FILE);
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const cookiesPath = args.cookies
    ? path.resolve(args.cookies)
    : findFirstExisting(DEFAULT_COOKIES_PATHS);

  const cookieMode = args["cookie-mode"] || "minimal";
  const cookieAllowList = args["cookie-allow"]
    ? String(args["cookie-allow"]).split(",").map(s => s.trim()).filter(Boolean)
    : DEFAULT_COOKIE_ALLOW;

  const cookieHeader = loadCookieHeader(cookiesPath, {
    mode: cookieMode,
    allowList: cookieAllowList,
  });
  if (!cookieHeader) {
    console.error("\n❌ No cookies found. Provide --cookies or place cookies.txt in v1/ or resources/.");
    process.exit(1);
  }

  const localStoragePath = args["localstorage"]
    ? path.resolve(args["localstorage"])
    : DEFAULT_LOCALSTORAGE_PATH;
  const localStorage = loadJsonSafe(localStoragePath) || {};

  const deploymentId = args["deployment-id"] || localStorage.regularDeploymentItem;
  const appId = args["app-id"] || localStorage.regularDeploymentAppId;

  if (!deploymentId) {
    console.error("\n❌ Missing deploymentId. Use --deployment-id or provide localStorage_dump.json.");
    process.exit(1);
  }

  const headers = {
    Cookie: cookieHeader,
    Accept: "application/json",
    "User-Agent": args["user-agent"] || DEFAULT_UA,
  };

  const agent = new https.Agent({ keepAlive: true, maxSockets: workers * 2 });

  console.log("═══════════════════════════════════════════════════════");
  console.log(" Abacus ChatLLM REST Exporter");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Deployment ID: ${deploymentId}`);
  if (appId) console.log(`App ID: ${appId}`);
  console.log(`Schema: ${schemaVersion}`);
  console.log(`Workers: ${workers}`);
  if (listLimit > MAX_LIST_LIMIT) {
    console.warn(`⚠ list-limit capped at ${MAX_LIST_LIMIT} by API constraints.`);
    listLimit = MAX_LIST_LIMIT;
  }

  console.log(`List limit: ${listLimit}`);
  console.log(`Message limit: ${messageLimit}`);
  console.log(`Delay per request: ${delayMs}ms`);
  console.log(`Timeout: ${timeoutMs}ms`);
  console.log(`Output: ${outFile}`);
  console.log("═══════════════════════════════════════════════════════\n");

  let items = [];
  let mode = "chats";

  if (args.ids) {
    const idsPath = path.resolve(args.ids);
    const idsData = readIdsFile(idsPath);
    items = idsData.items;
    mode = idsData.mode || "chats";
    if (!items.length) {
      console.error(`\n❌ No IDs found in ${idsPath}`);
      process.exit(1);
    }
  } else {
    const list = await listConversations({
      deploymentId,
      headers,
      listLimit,
      timeoutMs,
      agent,
    });

    if (list.length === listLimit) {
      console.warn("\n⚠ List returned the same count as list-limit. If you have more chats, re-run with a higher --list-limit.\n");
    }

    items = list.map(conv => ({
      id: conv.deploymentConversationId,
      title: conv.name || "",
      listEntry: conv,
    }));
  }

  if (limitConversations < Infinity) {
    items = items.slice(0, limitConversations);
  }

  const externalApplicationIds = new Set();
  for (const item of items) {
    if (item.listEntry?.externalApplicationId) {
      externalApplicationIds.add(item.listEntry.externalApplicationId);
    }
  }

  console.log("\nFetching light extras (listAllTasks + custom instructions + toolbar actions)...");
  const extras = await fetchLiteExtras({
    headers,
    timeoutMs,
    agent,
    externalApplicationIds: Array.from(externalApplicationIds),
  });

  const existingMap = new Map();
  const shouldUseExisting = !refetchAll && (resume || onlyNew);
  const shouldSkipExisting = !refetchAll && (resume || onlyNew);

  if (refetchAll && (resume || onlyNew)) {
    console.warn("⚠ refetch-all enabled: ignoring resume/only-new and re-downloading everything.");
  }

  if (shouldUseExisting && fs.existsSync(outFile)) {
    const existing = loadJsonSafe(outFile) || {};
    const convs = Array.isArray(existing.conversations) ? existing.conversations : [];
    for (const c of convs) existingMap.set(c.conversationId, c);
    if (shouldSkipExisting) {
      items = items.filter(item => !existingMap.has(item.id));
      const modeLabel = resume ? "resume" : "only-new";
      console.log(`${modeLabel} enabled: skipping ${existingMap.size} conversations already in output.`);
    }
  }

  console.log(`Conversations to fetch: ${items.length}`);
  if (items.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  let completed = 0;
  const total = items.length;
  const results = existingMap;

  const queue = items.map(item => ({
    id: item.id,
    title: item.title,
    listEntry: item.listEntry || null,
  }));

  let lastCheckpoint = 0;

  function writeOutput() {
    const conversations = Array.from(results.values());
    const output = {
      schemaVersion,
      source: "abacus-chatllm-lite",
      exportedAt: new Date().toISOString(),
      mode,
      appId: appId || null,
      deploymentId,
      extras,
      conversations,
    };
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  }

  async function maybeCheckpoint() {
    if (completed - lastCheckpoint >= checkpointEvery) {
      lastCheckpoint = completed;
      writeOutput();
    }
  }

  async function worker(workerId) {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;

      const capturedAt = new Date().toISOString();
      let conversation;
      let error = null;

      try {
        const data = await fetchConversation({
          deploymentId,
          conversationId: item.id,
          headers,
          messageLimit,
          timeoutMs,
          includeContext,
          includeAllVersions,
          agent,
        });

        const history = Array.isArray(data?.history) ? data.history : [];
        const title = item.title || data?.name || `Conversation ${item.id}`;

        conversation = buildConversationRecord({
          conversationId: item.id,
          title,
          history,
          capturedAt,
          includeSearchText,
          listEntry: item.listEntry,
          appId: appId || null,
          projectId: item.listEntry?.chatllmProjectId || null,
          projectName: null,
        });
      } catch (err) {
        error = err.message || "unknown error";
        conversation = {
          conversationId: item.id,
          title: item.title || `Conversation ${item.id}`,
          section: item.listEntry?.chatllmProjectId ? "projects" : "chats",
          projectId: item.listEntry?.chatllmProjectId || null,
          projectName: null,
          appId: appId || null,
          deploymentId: item.listEntry?.deploymentId || null,
          externalApplicationId: item.listEntry?.externalApplicationId || null,
          conversationType: item.listEntry?.conversationType || null,
          hasHistory: item.listEntry?.hasHistory ?? null,
          createdAt: item.listEntry?.createdAt || null,
          lastEventAt: item.listEntry?.lastEventCreatedAt || null,
          metadata: item.listEntry?.metadata || null,
          capturedAt,
          modelRaw: null,
          modelDisplay: null,
          model: null,
          messageCount: 0,
          messages: [],
          searchText: "",
          rawHtml: "",
        };
      }

      results.set(item.id, conversation);
      completed++;

      const pct = ((completed / total) * 100).toFixed(1);
      const msgCount = conversation.messageCount || 0;
      const status = msgCount > 0 ? `✓ ${msgCount} msgs` : `⚠ ${error || "0 msgs"}`;
      process.stdout.write(
        `\r[Worker ${workerId}] ${completed}/${total} (${pct}%) | ${item.title.slice(0, 40).padEnd(40)} ${status}   `
      );

      await maybeCheckpoint();
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  const workerPromises = Array.from({ length: workers }, (_, i) => worker(i + 1));
  await Promise.all(workerPromises);
  console.log();

  writeOutput();

  const conversations = Array.from(results.values());
  const totalMessages = conversations.reduce((sum, c) => sum + (c.messageCount || 0), 0);
  const failed = conversations.filter(c => (c.messageCount || 0) === 0).length;

  console.log("═══════════════════════════════════════════════════════");
  console.log(`Done! Output: ${outFile}`);
  console.log(`Conversations: ${conversations.length}`);
  console.log(`Total messages: ${totalMessages}`);
  if (failed > 0) console.log(`Failed (0 messages): ${failed}`);
  console.log("═══════════════════════════════════════════════════════");
}

run().catch(err => {
  console.error("\n❌ Fatal error:", err.message);
  if (err.url) console.error("URL:", err.url);
  if (err.body) console.error("Body:", err.body);
  process.exit(1);
});
