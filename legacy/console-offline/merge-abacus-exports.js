#!/usr/bin/env node
"use strict";

/*
Merge Abacus export files into one bundle.

Examples:
  node merge-abacus-exports.js
  node merge-abacus-exports.js abacus-export-chats.json abacus-export-projects.json --out abacus-export-bundle.json
*/

const fs = require("fs");
const path = require("path");

function usage() {
  console.log(
    [
      "Usage:",
      "  node merge-abacus-exports.js [input1.json input2.json ...] [--out output.json]",
      "",
      "Defaults:",
      "  inputs: abacus-export-chats.json abacus-export-projects.json",
      "  output: abacus-export-bundle.json"
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const inputs = [];
  let out = "abacus-export-bundle.json";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--out" || arg === "-o") {
      if (i + 1 >= args.length) {
        throw new Error("Missing output file after --out");
      }
      out = args[i + 1];
      i += 1;
      continue;
    }
    inputs.push(arg);
  }

  if (!inputs.length) {
    inputs.push("abacus-export-chats.json", "abacus-export-projects.json");
  }

  return { inputs, out };
}

function safeText(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function safeIso(value) {
  const parsed = Date.parse(value || "");
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function normalizeMessage(raw, index, conversationId) {
  return {
    messageId:
      safeText(raw && raw.messageId) || `${conversationId}-m${index + 1}`,
    role: safeText(raw && raw.role) || "unknown",
    timestamp: safeText(raw && raw.timestamp) || null,
    text: safeText(raw && raw.text),
    html: safeText(raw && raw.html)
  };
}

function normalizeConversation(raw, fallbackMode) {
  const conversationId = safeText(raw && raw.conversationId);
  if (!conversationId) {
    return null;
  }

  const mode = safeText(raw && raw.section) || fallbackMode || "chats";
  const messagesRaw = Array.isArray(raw && raw.messages) ? raw.messages : [];
  const messages = messagesRaw.map((m, idx) => normalizeMessage(m, idx, conversationId));

  return {
    conversationId,
    title: safeText(raw && raw.title) || conversationId,
    section: mode === "projects" ? "projects" : "chats",
    projectId: safeText(raw && raw.projectId) || null,
    projectName: safeText(raw && raw.projectName) || null,
    capturedAt: safeIso(raw && raw.capturedAt) || new Date(0).toISOString(),
    messageCount: Number(raw && raw.messageCount) > 0 ? Number(raw.messageCount) : messages.length,
    messages,
    searchText: safeText(raw && raw.searchText) || "",
    rawHtml: safeText(raw && raw.rawHtml)
  };
}

function chooseBetter(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  const existingScore =
    (existing.messageCount || 0) * 1000000 +
    Date.parse(existing.capturedAt || 0);
  const incomingScore =
    (incoming.messageCount || 0) * 1000000 +
    Date.parse(incoming.capturedAt || 0);

  if (incomingScore > existingScore) {
    return incoming;
  }

  return existing;
}

function readJsonFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const content = fs.readFileSync(abs, "utf8");
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }

  if (!doc || !Array.isArray(doc.conversations)) {
    throw new Error(`File ${filePath} is missing a conversations[] array`);
  }

  return {
    filePath,
    doc
  };
}

function main() {
  const { inputs, out } = parseArgs(process.argv);

  const files = inputs
    .map((p) => p.trim())
    .filter(Boolean)
    .map(readJsonFile);

  const byId = new Map();
  for (const { filePath, doc } of files) {
    const fallbackMode = safeText(doc.mode);
    for (const rawConversation of doc.conversations) {
      const normalized = normalizeConversation(rawConversation, fallbackMode);
      if (!normalized) {
        continue;
      }
      const existing = byId.get(normalized.conversationId);
      byId.set(normalized.conversationId, chooseBetter(existing, normalized));
    }
    console.log(
      `Loaded ${doc.conversations.length} conversations from ${filePath}`
    );
  }

  const conversations = Array.from(byId.values()).sort((a, b) => {
    const aTs = Date.parse(a.capturedAt || 0);
    const bTs = Date.parse(b.capturedAt || 0);
    if (aTs !== bTs) {
      return bTs - aTs;
    }
    return a.title.localeCompare(b.title);
  });

  const bundle = {
    schemaVersion: "1.0",
    source: "abacus-chatllm",
    exportedAt: new Date().toISOString(),
    mode: "bundle",
    conversations
  };

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), "utf8");
  console.log(`Wrote ${outPath} (${conversations.length} conversations)`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
