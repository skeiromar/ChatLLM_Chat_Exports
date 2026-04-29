# Abacus ChatLLM REST Exporter (v1)

This is the supported exporter flow for the public repository. It calls the Abacus ChatLLM REST endpoints directly using local cookies and optional local storage values.

**What it produces**
- A single JSON file containing every conversation and message.
- Schema `3.0-lite` by default (unified, view-ready fields + light extras).

**Quick start**
1. Ensure Node.js 18+ is installed.
2. Put your cookies in `v1/cookies.txt`, `resources/cookies.txt`, `v1/cookies.json`, or `resources/cookies.json`.
3. If you do not already have `resources/localStorage_dump.json`, open browser DevTools, perform a few actions in ChatLLM, export the Network log as a HAR file, and read:
   - `appId` from the ChatLLM page URL or request URL
   - `deploymentId` from `listDeploymentConversations` or `getDeploymentConversation` requests
4. Run the exporter:

```bash
node v1/export_chatllm.js
```

**Output**
- Default output path: `v1/out/abacus-chats.json`
- Includes light `extras` (tasks + custom instructions + toolbar actions) and a unified message schema.

## Project Exports (separate workflow)
Use the dedicated project exporter to download chats that live inside ChatLLM Projects. This keeps the core exporter unchanged.

**Run**
```bash
node v1/export_chatllm_projects.js
```

**Output**
- Default output path: `v1/out/abacus-project-chats.json`
- Includes `projects[]` metadata plus light `extras` (tasks + custom instructions + toolbar actions).

**Project filters**
- `--project-id <id1,id2>` Export only specific projects.
- `--project-name <substring>` Export projects whose name includes the substring (case-insensitive).
- `--limit <n>` Limit conversations fetched (useful for testing).

**Viewer (local preview)**
1. Start a local server from the repository root:
2. `python3 -m http.server 8788 --directory v1`
3. Open `http://localhost:8788/viewer/`

**Viewer project navigation**
- A “Projects” folder appears under the search bar.
- Click to expand projects, then chats inside each project.
- Regular (non-project) chats appear below the Projects folder.

**Deployment/app IDs**
- The script auto-reads `resources/localStorage_dump.json` for:
- `regularDeploymentItem` → `deploymentId`
- `regularDeploymentAppId` → `appId`
- If you do not have that file, pass `--deployment-id` and `--app-id` from your HAR or DevTools capture.

**Common options**
- `--deployment-id <id>` Set deployment ID explicitly.
- `--app-id <id>` Set app ID explicitly.
- `--cookies <path>` Cookie file path (overrides defaults).
- `--out <path>` Output JSON path.
- `--schema <3.0-lite>` Output schema (only `3.0-lite` is supported; other values are ignored).
- `--list-limit <n>` Max conversations to fetch from the list API (default: `100`, API cap).
- `--message-limit <n>` Max messages per conversation (default: `2000`).
- `--workers <n>` Parallel requests (default: `6`).
- `--delay-ms <n>` Delay between requests per worker.
- `--timeout-ms <n>` Request timeout (default: `30000`).
- `--limit <n>` Only process the first N conversations.
- `--ids <file>` Read conversation IDs from a JSON file instead of listing.
- `--resume` Skip conversations already present in the output file.
- `--only-new` Fetch only conversations not already in the output file (merge with existing).
- `--refetch-all` Ignore existing output and re-download everything.
- `--checkpoint-every <n>` Write a partial output file every N conversations.
- `--no-search-text` Skip `searchText` generation.
- `--include-context` Include `includeContext=true` in API calls.
- `--include-all-versions false` Disable `includeAllVersions` in API calls.
- `--cookie-mode <minimal|all>` Cookie filtering (default: `minimal` to avoid 400 header-too-large errors).
- `--cookie-allow <names>` Comma-separated allowlist (default: `_s_p,_u_p,_a_p,_ss_p`).

**Examples**
```bash
# Full export with defaults
node v1/export_chatllm.js

# Explicit deployment/app IDs and a custom output
node v1/export_chatllm.js --deployment-id <deploymentId> --app-id <appId> --out v1/out/abacus-chats.json

# Faster retry on a flaky run
node v1/export_chatllm.js --resume --workers 8 --delay-ms 100

# Explicit schema (3.0-lite)
node v1/export_chatllm.js --schema 3.0-lite
```

**Notes**
- If the list call returns exactly your `--list-limit` count, increase the limit and re-run.
- The REST API returns plaintext message content. The `html` field is filled with the same text for compatibility.
- HAR files are not required. They can help you discover IDs during debugging, but the exporter itself uses direct REST calls.
