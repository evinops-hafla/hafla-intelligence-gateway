# EvWA MCP — setup & verification (Claude Code)

Paste the prompt below into Claude Code. It sets up and verifies your access to
Hafla's EvWA Intelligence MCP (`mcp.hafla.com`) on this machine, lists the live
tools, and refreshes any stale local notes. It confirms before changing any
config file.

---

You're setting up and verifying my access to Hafla's EvWA Intelligence MCP (the
`mcp.hafla.com` gateway) on THIS machine, and refreshing any stale notes about
it. Work through the steps in order, verify each one, and only change a config
file after showing me the change and getting my OK. Give a short status report
at the end.

1. **Prerequisites** — read
   [PREREQUISITES.md](https://github.com/evinops-hafla/hafla-intelligence-gateway/blob/main/packages/intelligence-mcp-bridge/PREREQUISITES.md)
   and check my machine against it: Node 24 LTS (via a version manager), and the
   Google Cloud CLI signed in with my `@hafla.com` account.
   **Critical auth gotcha:** I must be logged in with the STANDARD gcloud CLI via
   `gcloud auth login`. If my gcloud was set up through a branded installer
   (Gemini Code Assist / Cloud Code), the identity token's audience is rejected
   by the gateway with HTTP 403. Verify `gcloud config get-value account` ends in
   `@hafla.com` and `gcloud auth print-identity-token` succeeds. Flag any gap
   with the exact fix.

2. **Bridge config** — read
   [the bridge README](https://github.com/evinops-hafla/hafla-intelligence-gateway/blob/main/packages/intelligence-mcp-bridge/README.md)
   and make sure the `@hafla/intelligence-mcp-bridge` MCP server is configured in
   my Claude Code correctly — with ABSOLUTE node + bridge paths (per the README's
   launchd/version-manager note, since a GUI-launched app won't see nvm/fnm
   paths). Show me the diff before writing to any config file.

3. **Context** — read
   [the repo README](https://github.com/evinops-hafla/hafla-intelligence-gateway/blob/main/README.md)
   so you understand what this is (client packages for the `mcp.hafla.com`
   gateway; the two-"gateway" naming). Don't change anything here.

4. **Live tool list** — get the current EvWA tools. Prefer the connected MCP
   server if it's available; otherwise run the bridge directly over stdio:

   ```bash
   echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
     | npx -y @hafla/intelligence-mcp-bridge
   ```

   If it returns a 403, apply the vanilla-gcloud fix from step 1 and retry. Then
   list the tools you got and the count.

5. **Refresh memory** — find every memory/note on this machine about the EvWA MCP
   and its tools. Compare against the live tool list (step 4) and the docs above;
   update anything stale (tool names, tool count, the auth model) and delete
   anything wrong.

Report back: what was already correct, what you fixed, what still needs my
action, and the final working tool count.

---

## Optional — also install the EvWA skills (plugin)

To install the EvWA skills (supplier-discovery, pricing-lookup, product-brief,
past-orders, venue-recommendation, event-needs), run these two commands in
Claude Code:

```text
/plugin marketplace add evinops-hafla/hafla-intelligence-gateway
/plugin install evwa-intelligence@hafla-intelligence-gateway
```
