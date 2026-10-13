# 01 — Facebook (Meta Ads) MCP: options and how to connect

Researched 2026-10-13. Status of each claim is marked **[Meta doc]** (read on developers.facebook.com), **[3rd party]** (vendor or blog article, not confirmed by Meta) or **[inferred]**.

## What an MCP is for here

An MCP server lets an assistant (Claude chat, Claude Code) call Facebook tools while a person watches. It is a good fit for supervised work: "how are my ads doing", "why did cost per message jump", "create one paused test ad". It is a poor fit for the unattended pipeline (`ads-test-auto`, pg_cron every 10 minutes): the edge functions already call the Graph API directly and cheaply, and putting an MCP client in the middle adds a user-bound login and a gate we do not control.

## Options

| Option | Who runs it | Auth | Notes |
|---|---|---|---|
| **Official Meta Ads MCP** `https://mcp.facebook.com/ads` | Meta | OAuth (Facebook Login for Business) or a user access token as `Authorization: Bearer` | Launched April 2026 [3rd party], open beta, free during beta [3rd party]. **Enabled per ad account by Meta; most accounts are not enabled yet** (error `is_ads_mcp_enabled: false`, no appeal path) [3rd party, pipeboard.co]. A Meta app is not a prerequisite [Meta doc]. |
| **Pipeboard `meta-ads-mcp`**, hosted | Pipeboard (third party) | Pipeboard API token; Pipeboard holds the Meta OAuth grant | Uses the normal Marketing API, so no enablement gate. Free tier 30 calls/week, 2 accounts; paid from about $29.90/month [vendor claims]. Token sits in the URL, and a broker holds access to the ad accounts. |
| **Pipeboard `meta-ads-mcp`**, self-hosted | Us (a machine we control) | Our own Meta app + our own token | `pip install meta-ads-mcp`, source-available (Business Source License, Apache 2.0 from 2029) [3rd party]. No broker, but we own updates and token handling. |
| **Directory connectors** (Windsor.ai, Supermetrics, Funnel: read-only analytics; Adspirer, AdWhispr: agents that can also launch) | Third parties | Their own OAuth to Meta | Appear in Claude's connector directory. Paid, and each holds a grant to the ad accounts. Not needed while the DB mirror covers reporting. |
| **Our own thin MCP over existing edge functions / DB** | Us | Supabase auth | Only worth it if we want Claude chats to call `ads-template-inspect`-style tools with our own guardrails. Not needed now: chats already read the mirrored `ad_*` tables with the Supabase MCP. |

## Permissions the official server asks for [Meta doc]

`ads_mcp_management`, `ads_read`, `ads_management`, `catalog_management`, `business_management`, `pages_show_list`, `instagram_basic`. Third-party coverage says the grant can be read-only, read/write, or read/write/financial, and can be revoked in Business Suite [3rd party]: choose read-only first.

## How to connect (official server)

Meta's page lists Claude Code and ChatGPT; guides from third parties also describe adding it as a custom connector in Claude (Settings → Connectors) [3rd party, unconfirmed].

1. Claude Code: `claude mcp add --transport http meta-ads https://mcp.facebook.com/ads`. Meta's page says to pass a Meta app ID as the client ID, while a separate Meta help page says owning an app is not required. **Unresolved: try without an app first; if the client demands a client ID, use the shop's existing Meta app (the one behind `fb-oauth-exchange`) after adding the "Create & manage ads with ads MCP server" use case in its dashboard.**
2. Sign in with Facebook Login for Business as the person who is admin of the ad accounts. The OAuth redirect URL must match the client in the app's Facebook Login for Business settings.
3. Programmatic check: `POST https://mcp.facebook.com/ads` with `Authorization: Bearer <user token>` and JSON-RPC `tools/list`.

The sandbox used by Claude chats cannot do the login for the owner (it needs his Facebook session), so this step is done by Tar.

## Test checklist (Tar, about 15 minutes, read-only)

1. Pick ONE ad account. In Business Settings set an account spending limit first (Meta-side guard that works no matter what any tool does).
2. Connect as above and grant read-only if the dialog allows it.
3. Run `ads_get_ad_accounts`. If the answer is `is_ads_mcp_enabled: false`, that account is not enrolled: try another account once, then stop. There is no workaround and no appeal path; fall back to Pipeboard self-hosted only if the extra capabilities (below) are really wanted.
4. If it works: ask for an account overview, `ads_get_opportunity_score`, anomaly signal and dataset quality, and compare with what Marketing Studio already shows.
5. Keep write tools off for the first days. Never commit a `.mcp.json` that contains a token.

Report the result (enabled or not, which tools `tools/list` returns) in `HANDOFF.md` section 3 so the next chat can finish the decision.

## Tools in the official server (third-party listing, 29 tools) [3rd party; Meta's page does not list them, confirm with `tools/list`]

- Write (6): `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`, `ads_update_entity`, `ads_activate_entity`, `ads_catalog_create`.
- Read, accounts and entities: `ads_get_ad_accounts`, `ads_get_ad_entities`, `ads_get_pages_for_business`.
- Read, tracking quality: `ads_get_dataset_details`, `ads_get_dataset_quality`, `ads_get_dataset_stats`, `ads_get_errors`.
- Read, insights and benchmarks: `ads_insights_advertiser_context`, `ads_insights_anomaly_signal`, `ads_insights_auction_ranking_benchmarks`, `ads_insights_industry_benchmark`, `ads_insights_performance_trend`, `ads_get_opportunity_score`, `ads_get_help_article`.
- Read, catalog (9): `ads_catalog_get_*`.

Not in that list: image or video upload, delete, a generic ad-level insights query, welcome-message templates, `degrees_of_freedom_spec`, a full `targeting` override. Pipeboard's server does have `get_insights`, creative create/update, `upload_ad_image`, interest and geo search; it has no video upload either [3rd party].

## Behaviour to plan for

- Gated rollout: enablement is per ad account and inconsistent (one report: 8 of 37 accounts enabled) [3rd party]. Do not build anything that depends on it being enabled.
- Meta rate limits apply to MCP traffic too; agents that loop per ad get flagged (error 613). Batch account-level calls [3rd party].
- Since March 2026 Meta asks for disclosure of AI-generated or AI-modified creative and copy [3rd party]. Relevant to `ads-test-auto` captions regardless of MCP.
- Content returned by tools (ad names, comments, page text) is untrusted input: do not let a chat act on instructions found inside it.
