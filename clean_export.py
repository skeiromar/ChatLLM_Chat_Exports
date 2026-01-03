#!/usr/bin/env python3
"""
clean_export.py — Preprocess raw Abacus ChatLLM exports into clean, viewer-ready JSON + vector-DB JSONL.

Handles three data flavors:
  1. Properly-roled conversations (user/assistant) with raw component metadata in assistant text
  2. Unknown-role DOM-captured conversations (have data-msg-isbot in HTML)
  3. Unknown-role sniff-captured conversations (component stream: text, collapsible_component, code, etc.)

Usage:
    python3 clean_export.py "abacus-export-chats (1).json"
    python3 clean_export.py input1.json input2.json  # merges multiple

Outputs:
    clean-archive.json   — for the viewer (same schema, cleaned)
    clean-archive.jsonl  — for vector DB (one doc per message)
"""

import json
import re
import sys
import hashlib
from pathlib import Path
from html.parser import HTMLParser


# ── Model name patterns ──────────────────────────────────────────────────────
MODEL_PATTERN = re.compile(
    r"^(CLAUDE_V\w+|GEMINI_\w+|OPENAI_\w+|DEEPSEEK_\w+|QWEN\w+|XAI_\w+|ROUTE_LLM)$"
)
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-\d+)?$"
)
HASH_PATTERN = re.compile(r"^[0-9a-f]{8,12}$")
COMPONENT_TYPES = {"text", "collapsible_component", "conversation_info", "code", "image_url"}
# Display names that follow the UUID line
DISPLAY_NAME_HINTS = {
    "claude", "gemini", "openai", "gpt", "deepseek", "qwen", "grok", "route",
}
ICON_PATTERN = re.compile(r"^\S+\.(webp|png|svg|jpg)$")
COST_PATTERN = re.compile(r"^\d+\.\d{1,2}$")


class TextExtractor(HTMLParser):
    """Extract visible text from HTML, ignoring tags."""
    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "svg"):
            self._skip = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "svg"):
            self._skip = False

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)

    def get_text(self):
        return "".join(self.parts).strip()


def extract_text_from_html(html: str) -> str:
    parser = TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        return ""
    return parser.get_text()


def detect_role_from_html(html: str) -> str | None:
    """Check for data-msg-isbot attribute in DOM-captured HTML."""
    m = re.search(r'data-msg-isbot="(\d)"', html)
    if m:
        return "assistant" if m.group(1) == "1" else "user"
    return None


def extract_model_from_text(text: str) -> str | None:
    """Extract model name from assistant text like '0 CLAUDE_V4_6_OPUS text 0 ...'"""
    m = re.match(r"^\d+\s+([A-Z][A-Z0-9_]+)", text)
    if m and MODEL_PATTERN.match(m.group(1)):
        return m.group(1)
    return None


def friendly_model_name(raw: str) -> str:
    """Convert CLAUDE_V4_6_OPUS → Claude 4.6 Opus"""
    mapping = {
        "CLAUDE_V4_6_OPUS": "Claude 4.6 Opus",
        "CLAUDE_V4_6_SONNET": "Claude 4.6 Sonnet",
        "CLAUDE_V4_5_OPUS": "Claude 4.5 Opus",
        "CLAUDE_V4_OPUS": "Claude 4 Opus",
        "CLAUDE_V4_SONNET": "Claude 4 Sonnet",
        "CLAUDE_V3_7_SONNET": "Claude 3.7 Sonnet",
        "CLAUDE_V3_7_SONNET_THINKING": "Claude 3.7 Sonnet (Thinking)",
        "CLAUDE_V3_5_SONNET": "Claude 3.5 Sonnet",
        "GEMINI_3_1_PRO": "Gemini 3.1 Pro",
        "GEMINI_3_PRO": "Gemini 3 Pro",
        "GEMINI_3_FLASH": "Gemini 3 Flash",
        "GEMINI_3_PRO_IMAGE": "Gemini 3 Pro (Image)",
        "GEMINI_2_5_PRO": "Gemini 2.5 Pro",
        "GEMINI_2_5_PRO_0605": "Gemini 2.5 Pro",
        "GEMINI_2_5_FLASH": "Gemini 2.5 Flash",
        "GEMINI_2_5_FLASH_IMAGE": "Gemini 2.5 Flash (Image)",
        "OPENAI_GPT5": "GPT-5",
        "OPENAI_GPT5_1": "GPT-5.1",
        "OPENAI_GPT5_2": "GPT-5.2",
        "OPENAI_GPT5_2_CODEX": "GPT-5.2 Codex",
        "OPENAI_GPT5_2_THINKING_HIGH": "GPT-5.2 (Thinking High)",
        "OPENAI_GPT5_HIGH": "GPT-5 High",
        "OPENAI_GPT5_LOW": "GPT-5 Low",
        "OPENAI_GPT5_MINI": "GPT-5 Mini",
        "OPENAI_GPT5_MINIMAL": "GPT-5 Minimal",
        "OPENAI_GPT5_CHAT": "GPT-5 Chat",
        "OPENAI_GPT4_1": "GPT-4.1",
        "OPENAI_GPT4O": "GPT-4o",
        "OPENAI_O3_HIGH": "o3 High",
        "OPENAI_O4_MINI_HIGH": "o4-mini High",
        "DEEPSEEK_R1": "DeepSeek R1",
        "QWEN3_MAX": "Qwen3 Max",
        "QWEN3_235B_A22B": "Qwen3 235B",
        "XAI_GROK_4": "Grok 4",
        "ROUTE_LLM": "Auto (RouteLLM)",
    }
    return mapping.get(raw, raw.replace("_", " ").title())


def is_metadata_line(line: str) -> bool:
    """Check if a line is metadata (model name, UUID, icon, cost, etc.)."""
    stripped = line.strip()
    if not stripped:
        return True
    if MODEL_PATTERN.match(stripped):
        return True
    if UUID_PATTERN.match(stripped):
        return True
    if HASH_PATTERN.match(stripped):
        return True
    if ICON_PATTERN.match(stripped):
        return True
    if COST_PATTERN.match(stripped):
        return True
    if stripped.isdigit():
        return True
    # Display model names (e.g. "Gemini 3 Flash", "Claude 4.6 Opus")
    lower = stripped.lower()
    if any(lower.startswith(h) for h in DISPLAY_NAME_HINTS):
        words = stripped.split()
        if len(words) <= 5 and all(w[0].isupper() or w[0].isdigit() or w.startswith("(") for w in words):
            return True
    if stripped in ("true", "false"):
        return True
    return False


def parse_pre_content(html: str) -> str:
    """Parse <pre>...</pre> content, stripping component metadata."""
    # Remove <pre> tags
    content = re.sub(r"</?pre>", "", html).strip()
    return content


def clean_assistant_blob(text: str) -> tuple[str, str | None, str | None]:
    """
    Clean a properly-roled assistant message blob.
    Returns (clean_text, thinking_text, model_name).

    Input format: '0 MODEL_NAME component_type index content... hash component_type ...'
    HTML format: newline-separated version of the same.
    """
    model = extract_model_from_text(text)

    # Split into lines for parsing (text uses spaces but we need the HTML which uses newlines)
    # We'll parse using a state machine approach on the text
    lines = text.split("\n") if "\n" in text else text.split("  ")  # fallback

    content_parts = []
    thinking_parts = []
    seen_content = set()
    current_component = None
    skip_next_metadata = 0

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Skip empty lines
        if not line:
            i += 1
            continue

        # Detect component start: a number followed by model name
        if line.isdigit() and i + 1 < len(lines):
            next_line = lines[i + 1].strip()
            if MODEL_PATTERN.match(next_line):
                # Start of a new response block, skip the number and model name
                i += 2
                continue

        # Skip model name lines
        if MODEL_PATTERN.match(line):
            i += 1
            continue

        # Detect component type
        if line in COMPONENT_TYPES:
            current_component = line
            i += 1
            # Skip the index number that follows
            if i < len(lines) and lines[i].strip().isdigit():
                i += 1
            continue

        # Skip metadata lines
        if is_metadata_line(line):
            i += 1
            continue

        # Collect content
        if current_component == "conversation_info":
            # Skip conversation_info content
            i += 1
            continue
        elif current_component == "collapsible_component":
            # This is thinking content
            # The format is: "Thought for X seconds" then index, "false", "text", content, "false", "false"
            if line.startswith("Thought for"):
                i += 1
                continue
            if line in ("true", "false"):
                i += 1
                continue
            if line == "text":
                current_component = "_thinking_text"
                i += 1
                continue
            thinking_parts.append(line)
            i += 1
            continue
        elif current_component == "_thinking_text":
            if line in ("true", "false"):
                current_component = None
                i += 1
                continue
            thinking_parts.append(line)
            i += 1
            continue
        elif current_component == "image_url":
            i += 1
            continue
        else:
            # text or code content
            content_hash = hashlib.md5(line[:200].encode()).hexdigest()
            if content_hash not in seen_content:
                seen_content.add(content_hash)
                content_parts.append(line)
            i += 1

    clean = "\n".join(content_parts).strip()
    thinking = "\n".join(thinking_parts).strip() or None

    return clean, thinking, friendly_model_name(model) if model else None


def clean_assistant_text_simple(text: str) -> tuple[str, str | None, str | None]:
    """
    Simpler cleaning for assistant messages — strips component metadata prefix and
    preserves original newlines in the content.
    """
    model = extract_model_from_text(text)

    # Use newlines if available (HTML <pre> content), otherwise reconstruct them.
    raw = text
    if "\n" not in raw:
        for comp in COMPONENT_TYPES:
            raw = re.sub(rf"\s+{comp}\s+", f"\n{comp}\n", raw)

    lines = raw.split("\n")
    content_lines = []
    thinking_lines = []
    in_thinking = False
    in_conv_info = False
    seen = set()
    # Track empty lines to preserve paragraph breaks in content
    pending_blank = False

    for line in lines:
        stripped = line.strip()

        # Preserve blank lines as paragraph separators in content
        if not stripped:
            if content_lines:
                pending_blank = True
            continue

        # Component type markers
        if stripped in COMPONENT_TYPES:
            in_thinking = stripped == "collapsible_component"
            in_conv_info = stripped == "conversation_info"
            continue

        if in_conv_info:
            if stripped in COMPONENT_TYPES:
                in_conv_info = False
            continue

        if is_metadata_line(stripped):
            continue

        if stripped.startswith("Thought for") and "seconds" in stripped:
            continue

        sig = hashlib.md5(stripped[:200].encode()).hexdigest()
        if sig in seen:
            continue
        seen.add(sig)

        if in_thinking:
            thinking_lines.append(stripped)
        else:
            # Re-insert blank line between paragraphs
            if pending_blank and content_lines:
                content_lines.append("")
            pending_blank = False
            content_lines.append(stripped)

    clean = "\n".join(content_lines).strip()
    thinking = "\n".join(thinking_lines).strip() or None

    # If cleaning produced nothing or very little, fall back to stripping just the prefix
    if len(clean) < 20 and len(text) > 50:
        m = re.match(r"^\d+\s+[A-Z][A-Z0-9_]+\s+(?:text|code)\s+\d+\s+", text)
        if m:
            clean = text[m.end():]
        else:
            clean = text

    return clean, thinking, friendly_model_name(model) if model else None


def parse_sniffed_component(text: str) -> tuple[str, str, str]:
    """
    Parse a sniff-captured component message with unknown role.
    Format: 'component_type index content...' or 'component_type content index ...'
    Returns (component_type, content, extra_info).
    """
    parts = text.split(" ", 1)
    if not parts:
        return "unknown", text, ""

    comp_type = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    if comp_type == "text":
        # Format: text <index> <content>
        m = re.match(r"(\d+)\s+(.*)", rest, re.DOTALL)
        if m:
            return "text", m.group(2), ""
        return "text", rest, ""

    elif comp_type == "code":
        m = re.match(r"(\d+)\s+(.*)", rest, re.DOTALL)
        if m:
            return "code", m.group(2), ""
        return "code", rest, ""

    elif comp_type == "collapsible_component":
        # Format: collapsible_component Thought for X seconds <index> false text <thinking_content> false false
        m = re.match(r"(Thought for [\d.]+ seconds?)\s+\d+\s+(?:false\s+)?(?:text\s+)?(.*?)(?:\s+false\s+false)?$", rest, re.DOTALL)
        if m:
            return "thinking", m.group(2).strip(), m.group(1)
        return "thinking", rest, ""

    elif comp_type == "conversation_info":
        return "conversation_info", rest, ""

    elif comp_type == "image_url":
        return "image", rest, ""

    else:
        # Not a known component — probably user text captured without prefix
        return "user_text", text, ""


def process_properly_roled(conversation: dict) -> dict:
    """Process a conversation that already has user/assistant roles."""
    messages = conversation.get("messages", [])
    cleaned_messages = []
    model_name = None

    for msg in messages:
        role = (msg.get("role") or "unknown").lower()
        text = (msg.get("text") or "").strip()
        html = (msg.get("html") or "").strip()

        if role == "assistant":
            # Clean the component metadata from assistant text
            # Use HTML if it has <pre> (newline-separated, easier to parse)
            source = html if html.startswith("<pre>") else text
            if html.startswith("<pre>"):
                source = parse_pre_content(html)

            clean, thinking, model = clean_assistant_text_simple(source)
            if model:
                model_name = model

            entry = {
                "role": "assistant",
                "content": clean,
                "model": model or model_name,
            }
            if thinking:
                entry["thinking"] = thinking
            cleaned_messages.append(entry)

        elif role == "user":
            cleaned_messages.append({
                "role": "user",
                "content": text if text else extract_text_from_html(html),
            })
        else:
            # Try to detect from HTML
            detected = detect_role_from_html(html)
            content = text if text else extract_text_from_html(html)
            cleaned_messages.append({
                "role": detected or "unknown",
                "content": content,
            })

    return build_clean_conversation(conversation, cleaned_messages, model_name)


def process_unknown_role_dom(conversation: dict) -> dict:
    """Process DOM-captured conversations with data-msg-isbot in HTML."""
    messages = conversation.get("messages", [])
    cleaned_messages = []
    model_name = None

    for msg in messages:
        text = (msg.get("text") or "").strip()
        html = (msg.get("html") or "").strip()
        role = detect_role_from_html(html)

        if role == "assistant":
            # Check if text has model prefix (sometimes DOM-captured assistant still has it)
            model = extract_model_from_text(text)
            if model:
                model_name = friendly_model_name(model)
                # Also try to detect model from text content like "Gemini 3.1 Pro Thought..."

            # For DOM-captured, text is usually cleaner
            content = text
            # Check if it starts with a model display name and strip it
            m = re.match(r"^(Gemini[\s\d.]+\w+|Claude[\s\d.]+\w+|GPT-[\d.]+\w*)\s+", content)
            if m:
                if not model_name:
                    model_name = m.group(1)
                content = content[m.end():]

            cleaned_messages.append({
                "role": "assistant",
                "content": content,
                "model": model_name,
            })
        elif role == "user":
            cleaned_messages.append({
                "role": "user",
                "content": text if text else extract_text_from_html(html),
            })
        else:
            cleaned_messages.append({
                "role": "unknown",
                "content": text if text else extract_text_from_html(html),
            })

    return build_clean_conversation(conversation, cleaned_messages, model_name)


def process_unknown_role_sniff(conversation: dict) -> dict:
    """Process sniff-captured conversations (component stream, all unknown roles)."""
    messages = conversation.get("messages", [])
    model_name = None

    # Parse all components
    components = []
    for msg in messages:
        text = (msg.get("text") or "").strip()
        if not text:
            continue
        comp_type, content, extra = parse_sniffed_component(text)
        if comp_type == "conversation_info":
            continue
        components.append({
            "type": comp_type,
            "content": content.strip(),
            "extra": extra,
        })

    # Group consecutive assistant components into turns
    # Components with types: text, code, thinking, image are all assistant
    # Components with type: user_text are user
    cleaned_messages = []
    current_assistant_parts = []
    current_thinking_parts = []

    def flush_assistant():
        nonlocal current_assistant_parts, current_thinking_parts
        if current_assistant_parts or current_thinking_parts:
            content = "\n\n".join(p for p in current_assistant_parts if p)
            entry = {
                "role": "assistant",
                "content": content,
                "model": model_name,
            }
            if current_thinking_parts:
                entry["thinking"] = "\n\n".join(current_thinking_parts)
            if content or current_thinking_parts:
                cleaned_messages.append(entry)
            current_assistant_parts = []
            current_thinking_parts = []

    for comp in components:
        if comp["type"] == "user_text":
            flush_assistant()
            cleaned_messages.append({
                "role": "user",
                "content": comp["content"],
            })
        elif comp["type"] == "thinking":
            current_thinking_parts.append(comp["content"])
        elif comp["type"] == "code":
            current_assistant_parts.append(f"```\n{comp['content']}\n```")
        elif comp["type"] == "image":
            current_assistant_parts.append(f"[Image: {comp['content']}]")
        else:
            # text
            current_assistant_parts.append(comp["content"])

    flush_assistant()

    return build_clean_conversation(conversation, cleaned_messages, model_name)


def build_clean_conversation(original: dict, messages: list, model_name: str | None) -> dict:
    """Build the final clean conversation object."""
    # Remove empty messages and deduplicate
    seen_sigs = set()
    deduped = []
    for msg in messages:
        content = (msg.get("content") or "").strip()
        if not content and not msg.get("thinking"):
            continue
        sig = hashlib.md5(f"{msg['role']}:{content[:500]}".encode()).hexdigest()
        if sig in seen_sigs:
            continue
        seen_sigs.add(sig)
        deduped.append(msg)

    return {
        "conversationId": original.get("conversationId", ""),
        "title": (original.get("title") or "Untitled").strip(),
        "section": original.get("section", "chats"),
        "projectId": original.get("projectId"),
        "projectName": original.get("projectName"),
        "capturedAt": original.get("capturedAt"),
        "model": model_name,
        "messageCount": len(deduped),
        "messages": deduped,
    }


def classify_conversation(conv: dict) -> str:
    """Classify a conversation into its data flavor."""
    messages = conv.get("messages", [])
    if not messages:
        return "empty"

    roles = {m.get("role", "unknown") for m in messages}
    if "user" in roles or "assistant" in roles:
        return "properly_roled"

    # Check if DOM-captured (has data-msg-isbot in HTML)
    for m in messages[:3]:
        html = m.get("html", "")
        if "data-msg-isbot" in html:
            return "dom_captured"

    # Check if sniff-captured (has component prefixes in text)
    for m in messages[:3]:
        text = (m.get("text") or "").strip()
        first_word = text.split(" ")[0] if text else ""
        if first_word in COMPONENT_TYPES:
            return "sniff_captured"

    return "dom_captured"  # Default fallback


def process_conversation(conv: dict) -> dict:
    """Route to the appropriate processor."""
    flavor = classify_conversation(conv)
    if flavor == "empty":
        return build_clean_conversation(conv, [], None)
    elif flavor == "properly_roled":
        return process_properly_roled(conv)
    elif flavor == "dom_captured":
        return process_unknown_role_dom(conv)
    else:
        return process_unknown_role_sniff(conv)


def generate_jsonl(conversations: list, output_path: Path):
    """Generate JSONL for vector DB — one document per message with context."""
    with open(output_path, "w", encoding="utf-8") as f:
        for conv in conversations:
            if not conv.get("messages"):
                continue
            for i, msg in enumerate(conv["messages"]):
                content = (msg.get("content") or "").strip()
                if not content:
                    continue
                doc = {
                    "conversation_id": conv["conversationId"],
                    "conversation_title": conv["title"],
                    "message_index": i,
                    "role": msg.get("role", "unknown"),
                    "content": content,
                    "model": msg.get("model") or conv.get("model"),
                    "section": conv.get("section", "chats"),
                    "project": conv.get("projectName") or conv.get("projectId"),
                    "captured_at": conv.get("capturedAt"),
                }
                if msg.get("thinking"):
                    doc["thinking"] = msg["thinking"]
                f.write(json.dumps(doc, ensure_ascii=False) + "\n")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 clean_export.py <export.json> [export2.json ...]")
        sys.exit(1)

    all_conversations = []
    for path in sys.argv[1:]:
        print(f"Reading {path}...")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        convs = data.get("conversations", [])
        print(f"  Found {len(convs)} conversations")
        all_conversations.extend(convs)

    # Deduplicate by conversationId (keep the one with more messages)
    by_id = {}
    for conv in all_conversations:
        cid = conv.get("conversationId", "")
        if not cid:
            continue
        existing = by_id.get(cid)
        if not existing or len(conv.get("messages", [])) > len(existing.get("messages", [])):
            by_id[cid] = conv

    raw_convs = list(by_id.values())
    print(f"\nDeduped to {len(raw_convs)} unique conversations")

    # Classify
    from collections import Counter
    flavors = Counter(classify_conversation(c) for c in raw_convs)
    print(f"Data flavors: {dict(flavors)}")

    # Process
    print("\nProcessing...")
    cleaned = []
    for i, conv in enumerate(raw_convs):
        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(raw_convs)}")
        cleaned.append(process_conversation(conv))

    # Sort by capturedAt (newest first), then title
    cleaned.sort(key=lambda c: (c.get("capturedAt") or "", c.get("title", "")), reverse=True)

    # Stats
    with_msgs = [c for c in cleaned if c["messageCount"] > 0]
    total_msgs = sum(c["messageCount"] for c in cleaned)
    print(f"\nResult: {len(cleaned)} conversations, {len(with_msgs)} with messages, {total_msgs} total messages")

    # Write clean JSON
    output_dir = Path(sys.argv[1]).parent
    clean_json = output_dir / "clean-archive.json"
    archive = {
        "schemaVersion": "2.0",
        "source": "abacus-chatllm",
        "exportedAt": None,  # will be set
        "mode": "bundle",
        "conversations": cleaned,
    }

    from datetime import datetime, timezone
    archive["exportedAt"] = datetime.now(timezone.utc).isoformat()

    print(f"Writing {clean_json}...")
    with open(clean_json, "w", encoding="utf-8") as f:
        json.dump(archive, f, ensure_ascii=False)
    size_mb = clean_json.stat().st_size / (1024 * 1024)
    print(f"  {size_mb:.1f} MB")

    # Write JSONL for vector DB
    jsonl_path = output_dir / "clean-archive.jsonl"
    print(f"Writing {jsonl_path}...")
    generate_jsonl(cleaned, jsonl_path)
    jsonl_size = jsonl_path.stat().st_size / (1024 * 1024)
    print(f"  {jsonl_size:.1f} MB")

    print("\nDone!")


if __name__ == "__main__":
    main()
