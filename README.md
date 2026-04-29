# Abacus ChatLLM Exporter

Export your Abacus ChatLLM chats and project chats to local JSON, then browse them offline in the included viewer.

The supported workflow is `v1/`. It uses the Abacus ChatLLM REST endpoints directly with your logged-in browser session data.

![Abacus ChatLLM Chats Exporter](docs/images/clipboard_20260429-124934.png)

## Supported flow

1. Sign in to Abacus ChatLLM in your browser.
2. Collect the local session inputs used by the exporter:
   - `resources/cookies.txt` or `resources/cookies.json`
   - optional `resources/localStorage_dump.json`
3. If you do not have `resources/localStorage_dump.json`, open DevTools, perform a few actions in ChatLLM, export the Network log as a HAR file, and use it to find the IDs you need:
   - `appId`
     Look for a ChatLLM page URL such as `https://apps.abacus.ai/chatllm/?appId=...`
   - `deploymentId`
     Look for requests such as `listDeploymentConversations?deploymentId=...` or `getDeploymentConversation?deploymentId=...`
4. Run the regular chat exporter:

```bash
node v1/export_chatllm.js --limit 4 --deployment-id <deploymentId> --app-id <appId>
```

5. Run the project chat exporter if needed:

```bash
node v1/export_chatllm_projects.js --limit 4 --deployment-id <deploymentId> --app-id <appId>
```

6. Start the viewer:

```bash
python3 -m http.server 8788 --directory v1
```

7. Open `http://localhost:8788/viewer/`

The viewer auto-loads:

- `v1/out/abacus-chats.json`
- `v1/out/abacus-project-chats.json`

## Notes

If `resources/localStorage_dump.json` is present, the exporters auto-read:

- `regularDeploymentItem` as `deploymentId`
- `regularDeploymentAppId` as `appId`

If you do not have that file, pass `--deployment-id` and `--app-id` directly from your HAR or DevTools network capture.

## Version notes

`v1/` is the maintained version.

The files under `legacy/console-offline/` reflect earlier experiments around console scraping and offline post-processing. They remain in the repo only as reference material and should not be treated as the canonical flow.
