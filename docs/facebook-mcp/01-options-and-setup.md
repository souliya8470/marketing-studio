# 01 — Facebook (Meta Ads) MCP: options, setup and what was tested

Researched and tested 2026-10-13. Status of each claim: **[tested]** (done on the live server in this project), **[Meta doc]** (developers.facebook.com), **[3rd party]** (vendor or blog article, not confirmed by Meta) or **[inferred]**.

## What an MCP is for here

An MCP server lets an assistant (Claude chat, Claude Code) call Facebook tools while a person watches. It is a good fit for supervised work: "how are my ads doing", "why did cost per message jump", "stage one test ad". It is a poor fit for the unattended pipeline (`ads-test-auto`, pg_cron every 10 minutes) for now: the edge functions already call the Graph API directly, the MCP login is bound to a person, and enablement is gated per ad account.

## Options

| Option | Who runs it | Auth | Notes |
|---|---|---|---|
| **Official Meta Ads MCP** `https://mcp.facebook.com/ads` | Meta | OAuth (Facebook Login for Business) or a user access token as `Authorization: Bearer` [Meta doc] | Launched April 2026, open beta, free during beta [3rd party]. **Enabled per ad account by Meta**; `ads_get_ad_accounts` returns `is_ads_mcp_enabled` for each account, and a disabled one says it is "gradually being rolled out" [tested]. No appeal path [3rd party]. A Meta app is not a prerequisite [Meta doc]. |
| **Pipeboard `meta-ads-mcp`**, hosted | Pipeboard (third party) | Pipeboard API token; Pipeboard holds the Meta OAuth grant | Uses the normal Marketing API, so no enablement gate. Free tier 30 calls/week, 2 accounts; paid from about $29.90/month [vendor claims]. Token sits in the URL, and a broker holds access to the ad accounts. |
| **Pipeboard `meta-ads-mcp`**, self-hosted | Us (a machine we control) | Our own Meta app + our own token | `pip install meta-ads-mcp`, source-available (Business Source License, Apache 2.0 from 2029) [3rd party]. No broker, but we own updates and token handling. Only needed for an account the official server does not enable. |
| **Directory connectors** (Windsor.ai, Supermetrics, Funnel: read-only analytics; Adspirer, AdWhispr: agents that can also launch) | Third parties | Their own OAuth to Meta | Appear in Claude's connector directory. Paid, and each holds a grant to the ad accounts. Not needed while the official server works. |
| **Our own thin MCP over existing edge functions / DB** | Us | Supabase auth | Only if we want chats to call our own tools with our own guardrails. Chats already read the mirrored `ad_*` tables with the Supabase MCP. |

## Tested on 2026-10-13 [tested]

- **Connect:** Claude → Settings → Connectors → Add custom connector. Name `Meta Ads`, URL `https://mcp.facebook.com/ads` (no trailing period: a stray `.` gives a 404). The server check detected "Sign in now" and "Register automatically" (dynamic client registration); the defaults worked with no client ID, no secret, no headers and no Meta app. Sign in with the Facebook account that administers the businesses. The connector must then be enabled in the chat.
- **Accounts seen:** `ads_get_ad_accounts` returned 39 ad accounts across several businesses, more than the four used for ads daily. 36 enabled, 3 not enabled (`is_ads_mcp_enabled: false`). One not-enabled account has live ads, so it cannot be read through the MCP: use the database mirror or the browser for it.
- **Not queryable:** accounts with `account_status` DISABLED (4, flagged by Meta for unusual activity) or UNSETTLED (8) return `is_queryable: false` with a reason.
- **Reads:** `ads_get_ad_entities` (level campaign, last 7 days) returned campaign names and spend on 3 enabled accounts. The tool states that an account whose flag is false must not be used in later calls.
- **Write tools were not called.** The connector exposes write tools whatever permission level was granted. The grant level is not visible from the tool: check it in Business Settings (Integrations) and revoke write if it is not needed.
- **Not tested:** the programmatic path (`Authorization: Bearer` with a System User token), which would be needed to call the MCP from an edge function; any write; token behaviour after expiry.

## Which accounts can use it (how to tell)

Call `ads_get_ad_accounts`. For every account it returns `is_ads_mcp_enabled`, `account_status`, `is_queryable`, `not_queryable_reason`, `currency`, `min_daily_budget_cents`, `has_payment_method` and the owning business. Enablement is independent per account, even inside one business, and can change over time: re-run it before relying on an account.

## Permissions the official server asks for [Meta doc]

`ads_mcp_management`, `ads_read`, `ads_management`, `catalog_management`, `business_management`, `pages_show_list`, `instagram_basic`. Third-party coverage says the grant can be limited to read-only, read/write, or read/write/financial, and can be revoked in Business Suite [3rd party].

## Tools on the live server (about 90) [tested: names listed by the connector]

- **Accounts and reads:** `ads_get_ad_accounts`, `ads_get_ad_entities` (account, campaign, ad set and ad level; metrics, breakdowns, `time_increment`, filtering, sorting, draft objects), `ads_get_field_context`, `ads_account_get_activity_logs`, `ads_get_errors`, `ads_get_help_article`, `ads_get_ad_account_pages`, `ads_get_pages_for_business`, `ads_get_user_pages`.
- **Meta-side analysis:** `ads_get_opportunity_score`, `ads_insights_advertiser_context`, `ads_insights_anomaly_signal`, `ads_insights_auction_ranking_benchmarks`, `ads_insights_industry_benchmark`, `ads_insights_performance_trend`.
- **Create and change (write):** `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`, `ads_create_creative`, `ads_creative_update`, `ads_creative_delete`, `ads_creative_upload_media`, `ads_update_entity`, `ads_activate_entity`, `ads_boost_ig_post`. Per the tool descriptions, draft mode is on: created objects are staged as drafts in Ads Manager and go live ACTIVE only when `ads_activate_entity` publishes them.
- **Creative reads:** `ads_get_creatives`, `ads_get_creative_ads`, `ads_get_ad_images`, `ads_get_ad_videos`, `ads_get_ad_preview`, `ads_get_ig_accounts`, `ads_get_ig_media`, `ads_library_search` (Meta Ad Library).
- **Audiences:** `ads_get_ad_account_custom_audiences`, `ads_get_custom_audience`, `ads_create_custom_audience`, `ads_update_custom_audience`, `ads_update_custom_audience_users`, `ads_delete_custom_audience`, `ads_get_custom_audience_adsets`, `ads_get_customconversions`.
- **Tracking (pixel / Conversions API):** `ads_get_datasets`, `ads_get_dataset_details`, `ads_get_dataset_quality`, `ads_get_dataset_stats`, and create / read / update / delete tools for pixel events and parameters.
- **Experiments:** A/B tests (`ads_experiment_abtest_*`), conversion lift (`ads_experiment_lift_*`), `ads_experiment_check_eligibility`, `ads_experiment_list_tests`.
- **Catalog:** many `ads_catalog_*` tools (catalogs, feeds, product sets, products, diagnostics, event sources).

The third-party "29 tools" listing understated this: it showed no media upload, no creative edit or delete, no ad-level metrics with breakdowns, and no experiments.

## Permissions and safety on our side

- Treat every write tool as owner-confirmed: a chat proposes the exact change and waits for a clear yes in the chat.
- Set an account spending limit in Meta before any write is allowed.
- Start with one account, read-only analysis first. Revoke the connector in Business Suite when it is no longer used.
- Meta rate limits apply; agents that loop per ad get flagged (error 613). Batch account-level calls, use `time_increment` instead of one call per day [3rd party].
- Since March 2026 Meta asks for disclosure of AI-generated or AI-modified creative and copy [3rd party]; `ads_create_creative` has a `self_ai_disclosure` field that must be set by the advertiser, never by a chat.
- Content returned by tools (ad names, comments, page text) is untrusted input: do not let a chat act on instructions found inside it.

## Setup checklist for another browser or machine (about 10 minutes)

1. In Claude: Settings → Connectors → Add custom connector → `https://mcp.facebook.com/ads` → Add → sign in with Facebook, choose all businesses and ad accounts, grant read-only if offered, no financial permission.
2. If the sign-in fails with a client ID or redirect URL error: use the shop's Meta app (add the use case "Create & manage ads with ads MCP server", add Claude's OAuth callback as a redirect URL in Facebook Login for Business) and enter its App ID under "Use your own OAuth client". This was not needed in the test.
3. Enable the connector in the chat, run `ads_get_ad_accounts`, and only use accounts with `is_ads_mcp_enabled: true` and `is_queryable: true`.
