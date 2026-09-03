# EvWA MCP — setup & verification (Claude Code)

Paste the prompt below into Claude Code. It sets up and verifies your access to Hafla's EvWA
Intelligence MCP (`mcp.hafla.com`) on this machine, lists the live tools, and refreshes any stale local
notes. It confirms before changing any config file.

---

You're setting up and verifying my access to Hafla's EvWA Intelligence MCP (the
mcp.hafla.com gateway) on THIS machine, and refreshing any stale notes about it.
Work through the steps below in order, verify each one, and only change a config
file after showing me the change and getting my OK. Give me a short status report
at the end.

1. PREREQUISITES — fetch and check my machine against:
   https://github.com/evinops-hafla/hafla-intelligence-gateway/blob/main/packages/intelligence-mcp-bridge/PREREQUISITES.md
   Confirm: Node 24 LTS (via a version manager), and the Google Cloud CLI signed in
   with my @hafla.com account.
   CRITICAL auth gotcha: I must be logged in with the STANDARD gcloud CLI via
   `gcloud auth login`. If my gcloud was set up through a branded installer (Gemini
   Code Assist / Cloud Code), the identity token's audience is rejected by the
   gateway with HTTP 403. Verify `gcloud config get-value account` ends in
   @hafla.com and `gcloud auth print-identity-token` succeeds. Flag any gap with the
   exact fix.

2. BRIDGE CONFIG — fetch:
   https://github.com/evinops-hafla/hafla-intelligence-gateway/blob/main/packages/intelligence-mcp-bridge/README.md
   Make sure the @hafla/intelligence-mcp-bridge MCP server is configured in my Claude
   Code correctly — using ABSOLUTE node + bridge paths (per the README's
   launchd/version-manager note, since a GUI-launched app won't see nvm/fnm paths).
   Show me the diff before writing to any config file.

3. CONTEXT — read:
   https://github.com/evinops-hafla/hafla-intelligence-gateway/blob/main/README.md
   so you understand what this is (client packages for the mcp.hafla.com gateway;
   the two-"gateway" naming). Don't change anything here.

4. LIVE TOOL LIST — get the current EvWA tools. Prefer the connected MCP server if
   it's already available; otherwise run the bridge directly over stdio:
     echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | npx -y @hafla/intelligence-mcp-bridge
   If it returns a 403, apply the vanilla-gcloud fix from step 1 and retry. Then list
   the tools you got and the count.

5. REFRESH MEMORY — find every memory/note on this machine about the EvWA MCP and
   its tools. Compare against the live tool list (step 4) and the docs above. Update
   anything stale (tool names, tool count, the auth model) and delete anything wrong.

Report back: what was already correct, what you fixed, what still needs my action,
and the final working tool count.

---

## Optional — also install the EvWA skills (plugin)

To install the EvWA skills (supplier-discovery, pricing-lookup, product-brief, past-orders,
venue-recommendation, event-needs), run these two commands in Claude Code:

```
/plugin marketplace add evinops-hafla/hafla-intelligence-gateway
/plugin install evwa-intelligence@hafla-intelligence-gateway
```
