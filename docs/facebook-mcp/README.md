# Facebook MCP chat notes

Owner of this folder: the "Facebook MCP" chat (HANDOFF section 3). Last updated 2026-10-13.

Question: how do we connect a Facebook (Meta Ads) MCP, what would it add beyond the Graph API calls we already make, and how do we keep tokens safe?

## Short answer

1. **A Meta Ads MCP exists and is worth trying, as a supervised tool for Tar and Claude chats, not as part of the automated pipeline.** Official server: `https://mcp.facebook.com/ads` (Meta, open beta, enabled per ad account, most accounts not yet enabled). Fallback if the account is not enabled: Pipeboard's `meta-ads-mcp`, preferably self-hosted. See `01-options-and-setup.md`.
2. **It does not replace anything in the pipeline.** The official tool list (third-party listing, to confirm with `tools/list`) has no media upload, no delete, no raw ad-level insights query and none of our template features. What it adds is Meta-side analysis: benchmarks, anomaly signal, opportunity score, pixel / Conversions API quality. See `02-graph-usage-and-gaps.md`.
3. **Two dated problems in the existing Graph code.** On **2026-10-27** root `GET /?ids=` is removed for all API versions, and `sync-ad-creative-insights` uses it. On **2027-01-21** `v21.0`, which every function pins, is removed. See `04-api-deadlines.md`.
4. **Token and access hygiene must come before any new write path.** Rules in `03-token-security.md`; project-specific findings were given to Tar privately because this repo is public.

## Decisions needed from Tar

- Run the 15-minute read-only test in `01-options-and-setup.md` on one ad account and report enabled / not enabled.
- Confirm what kind of token `META_ACCESS_TOKEN` is (System User token or a user token) and set an account spending limit in Business Settings.
- Approve a fix for `sync-ad-creative-insights` before 2026-10-27 (pipeline chat or any chat that is not editing `index.html`; no `index.html` change needed).
- Decide when to act on the private security findings.

## Files

| File | Content |
|---|---|
| `01-options-and-setup.md` | Options compared, permissions, connection steps, test checklist, tool list |
| `02-graph-usage-and-gaps.md` | What each function calls on Facebook, gaps, what an MCP could add, join-point guidance |
| `03-token-security.md` | Token types and standing rules, pre-ship checklist |
| `04-api-deadlines.md` | API version and removal dates with impact and actions |

## Not done / limits of this research

- The official MCP was not connected or tested (needs the owner's Facebook login). Whether Tar's ad accounts are enabled is unknown.
- Meta's own page does not list the tools; the list comes from third-party articles.
- 11 of about 110 deployed functions were read.
- Secret values and token contents were never read; only table and policy metadata and a row count.

## Sources

- Meta, Ads MCP server, get started: https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started
- Meta, Graph API v26 and Marketing API v26: https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/
- Pipeboard, rollout gate: https://pipeboard.co/meta-ads-mcp-not-enabled
- Official Meta Ads MCP, 29 tools: https://pasqualepillitteri.it/en/news/1707/official-meta-ads-mcp-claude-29-tools-2026
- Superads, risks and rate limits: https://www.superads.ai/blog/facebook-ads-mcp
- MCP Directory, official vs community servers: https://mcp.directory/blog/meta-ads-mcp-complete-guide-2026
- Graph API version expiry: https://dev.to/flarecanary/metas-graph-api-v20-expires-september-24-your-calls-wont-fail-theyll-quietly-start-running-v21-2m2a
