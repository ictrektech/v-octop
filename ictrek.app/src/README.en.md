# v-Octop

An Octop-based VOS AI assistant with separate experts, conversations, memory, databases and workspaces for each user.

Open v-Octop in VOS. Platform identity signs in silently. Choose the default assistant or create an expert, describe a task, and manage generated files in the expert workspace.

V-Scheduler models visible to the current VOS user refresh every minute. Chat Completions, Responses and Messages interfaces require no separate model API key. Vision models retain their image input metadata. Completion-only models are excluded from agent tool execution.

Bundled V-Office, AI Album, HybRAG and Image Studio skills and MCP tools use the current user's authorization. These apps must be installed and accept this OIDC client where restricted. Missing apps, unavailable services and denied permissions produce errors. Third-party connectors retain their own authorization flows.

Find HybRAG under Connectors → Enabled connectors. The running gateway restores a missing local socket entry, and the connector reconnects after its next successful probe. Manually disabled connectors stay disabled. The connector API keeps the same request and response formats.

Each VOS subject has a separate Linux account, mount/PID namespace, Octop process and persistent home. Platform tokens remain in gateway memory. Networking is shared with the app container, and downstream services enforce user permissions.

With the Octop 1.0.3b6 base, open Experts → Expert Market to install templates, and use a shared expert to open a shared conversation. In Knowledge Bases, use the document or folder action menu to move it. For a custom MCP server that requires a preregistered OAuth application, open the expert’s Connectors → Custom MCP and enter the client credentials supplied by that server. Open [API reference](/app/com.ictrek.v-octop/api/docs) after signing in to inspect the live routes and schemas.

## MCPHub

In the same VOS deployment, enable a server in MCPHub and grant your account access. Open v-Octop → Connectors → Enabled connectors. Your available servers appear individually with the “From MCPHub” label. Select one under Optional Connectors in a chat. Discovery runs at sign-in and about every minute. To troubleshoot a missing server, check its enabled state and your permission in MCPHub, then refresh v-Octop after signing in again if the session has expired. Manage servers and permissions in MCPHub.

Open Connectors → API Reference after signing in. `GET /app/com.ictrek.v-octop/api/connector-instances` accepts no inputs and returns JSON visible to the current account. Find `kind: "mcphub"` rows and use their opaque `mcp_server_name` when selecting tools. These rows have `vos_managed: true` and `can_manage: false`. Instance detail, test and mutation routes return 404. The list returns 200 with no MCPHub rows when there are no visible enabled servers and 401 without a valid v-Octop session.

## VOS Operations

A VOS super administrator can open Admin → Application Settings → VOS Operations and authorize diagnostics for up to 15 minutes. Read application, workflow and container status, logs, published ports and image inventory. Select expert access at authorization to use the read-only `vos_diagnostics` tool. To restart an installed app, stop or remove an eligible old container, or remove an unreferenced, untagged image without repository digests, review the preview and enter the full target ID within 60 seconds. The VOS Operations API reference is in the same panel.
