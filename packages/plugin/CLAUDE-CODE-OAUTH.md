# EvWA MCP — connect Claude Code over OAuth (no gcloud)

Paste the prompt below into Claude Code. It connects this machine's Claude
Code to Hafla's EvWA Intelligence MCP (`mcp.hafla.com`) using the gateway's
OAuth (WorkOS AuthKit) — no `gcloud`, no bridge, no shared token. It confirms
before changing any config and verifies the connection at the end.

This is the OAuth alternative to the bridge path in
[`SETUP-PROMPT.md`](SETUP-PROMPT.md) — pick one. OAuth is the simplest route
and sidesteps the `gcloud` 403 audience-mismatch gotcha entirely; the bridge
stays canonical for automation and non-OAuth clients. First verified 2026-09-07
on one machine (a second-machine / teammate confirm is the natural next check);
CIMD self-registration works, and the token is resource-bound to the gateway
audience, so this path cannot hit the bridge's audience-mismatch 403 (an
authorization 403 — inactive employee / non-allowlisted domain — can still
occur; that's a different diagnosis).

---

You're connecting Claude Code (this CLI) to Hafla's EvWA Intelligence MCP (the
`mcp.hafla.com` gateway) on THIS machine over OAuth — no `gcloud`, no bridge.
Work through the steps in order, verify each one, and only change a config file
after showing me the change and getting my OK. Give a short status report at
the end.

1. **Prerequisites** — this path is light: Claude Code installed
   (`claude --version`), a web browser, and my `@hafla.com` Google login. It
   needs **no Node, no `gcloud`, and no bridge** — that is the whole point of
   OAuth. Confirm `claude --version` runs, and flag anything missing.

2. **Add the connector** — register the gateway as a remote HTTP MCP server
   under the canonical name, at user scope so it works from every directory:

   ```bash
   claude mcp add --transport http hafla-evwa-idl-gateway \
     https://mcp.hafla.com/mcp --scope user
   ```

   Show me the change before writing config. Use the bare name
   `hafla-evwa-idl-gateway` (no suffix) — I have only one gateway connection.
   If a server with that name already exists (e.g. the plugin's `gcloud`
   bridge), tell me: I either remove it first (simplest — then use the bare
   name in every step below), or — only if I want both auth routes at once —
   add this one as `hafla-evwa-idl-gateway-oauth` and use THAT name in every
   command below (login, verify, logout, remove) in place of the bare name.

3. **Authenticate** — sign in through the browser:

   ```bash
   claude mcp login hafla-evwa-idl-gateway
   ```

   Run this in a real interactive terminal (not a non-TTY subshell, or it
   fails with "stdin isn't a terminal"). A browser opens to WorkOS AuthKit
   (`secure-grace-01.authkit.app`); I sign in with my `@hafla.com` Google
   account and approve. On a headless box, add `--no-browser` and paste the
   redirect URL back. **You should NOT be asked for a Client ID or Secret** —
   the client self-registers (CIMD). If you are asked for one, stop and tell
   me. The token is stored in the OS keychain and auto-refreshes, so I will
   not re-login each session.

4. **Verify + list tools** — confirm the connection and enumerate the surface:

   ```bash
   claude mcp get hafla-evwa-idl-gateway
   ```

   Expect `✔ Connected`. Then, inside a Claude Code session, run `/mcp` to
   list the gateway's read-only tools and their count. Report the count back.

5. **Refresh memory** — carry out step 5 ("Refresh memory") of
   [`SETUP-PROMPT.md`](SETUP-PROMPT.md): find every note on this machine about
   the EvWA MCP, compare against the live tool list, and update anything
   stale. Treat **OAuth** and the **bridge** as both valid auth models — do
   not flag an OAuth note as wrong.

Report back: what was already correct, what you changed, what still needs my
action, and the final working tool count.

---

## Troubleshooting

- **`stdin isn't a terminal` on login** — you ran it in a non-interactive
  shell. Re-run `claude mcp login hafla-evwa-idl-gateway` in a real terminal,
  or add `--no-browser` and paste the redirect URL.
- **Still `! Needs authentication` after login, or a stale-credential
  warning** — re-stamp with a clean cycle:

  ```bash
  claude mcp logout hafla-evwa-idl-gateway
  claude mcp login hafla-evwa-idl-gateway
  ```

- **A 401 mid-session** — Claude Code refreshes the token and retries once; if
  it still fails, run the logout/login above.
- **Start over** — `claude mcp remove hafla-evwa-idl-gateway -s user`, then
  repeat from step 2.

## Notes

- Access requires an active `@hafla.com` identity — the gateway re-checks the
  email domain, so a personal Google account will not work.
- This is the Claude Code (CIMD) connection profile. For Claude Desktop and
  claude.ai Chat + Cowork (the DCR connector), see
  [`DESKTOP-SETUP.md`](DESKTOP-SETUP.md); for the bridge / `gcloud` route, see
  [`SETUP-PROMPT.md`](SETUP-PROMPT.md).
