# 02 — What the code already does on Facebook, and what an MCP would add

Inventory made 2026-10-13 by reading deployed source (Supabase project `swrijpkkufarddsyqhrh`) of 11 functions: `launch-ad` v30, `ads-template-inspect` v1, `ads-test-auto` v5 (snapshot in this repo), `sync-ad-spend` v30, `update-ad-entity` v23, `sync-ad-creative-insights` v2, `clone-ad-campaign` v32, `fb-oauth-exchange` v7, `run-campaign-control` v36, `run-scheduled-ad-pause` v9, `fb-upload-video` v6. About 110 functions are deployed; the other `fb-*`, `list-*`, `get-*` and `run-ads-*` functions were NOT read.

## Correction to HANDOFF section 4

HANDOFF says the pipeline talks to Facebook only through `launch-ad` and `ads-template-inspect`. In fact `ads-test-auto` also reads the Graph API directly (read-only `gget`, for the template campaign's ads and creatives), and the Graph API is used by at least 9 more functions (table below). Nothing here changes an interface; the join point just needs the accurate list.

## Calls in use (all on Graph API `v21.0`)

| Function | Reads | Writes |
|---|---|---|
| `ads-test-auto` | `{campaign}/ads` with creative fields (template copy) | none directly; launches through `launch-ad` |
| `ads-template-inspect` | campaign, ad sets (targeting, promoted_object, attribution_spec...), ads + creative | none |
| `launch-ad` | none | `act_X/campaigns`, `/adsets`, `/adcreatives`, `/ads`, `/adimages`; DELETE of an orphan campaign |
| `clone-ad-campaign` | campaign, ad sets, ads, creative | same create calls as `launch-ad`; rollback via `status=DELETED` |
| `sync-ad-spend` | `act_X/campaigns`, `/adsets` (+`learning_stage_info`), `/ads`, `/insights` (level=ad, daily), account balance and status | none |
| `sync-ad-creative-insights` | `act_X/insights` (7/30-day windows, reach, frequency, video retention), and a **root multi-id read** `/?ids=...&fields=creative{...}` | none |
| `run-campaign-control` | `/{id}/insights` (spend, actions) | budget, `daily_min_spend_target`, status |
| `update-ad-entity` | none | status, budget, `start_time`, bid strategy, DELETE |
| `run-scheduled-ad-pause` | none | status PAUSED / ACTIVE per campaign |
| `fb-upload-video` | video status, thumbnails | chunked `act_X/advideos`, `act_X/adimages` |
| `fb-oauth-exchange` | `oauth/access_token`, `/me` | none on Facebook (stores a per-user token in the DB) |

Insights are mirrored into DB tables daily by `sync-ad-spend`, so Claude chats can already answer "how are ads doing" from the database with the Supabase MCP; an MCP is not needed for that.

## What the code does NOT use (gaps)

- No handling of rate-limit headers (`x-business-use-case-usage`, `x-ad-account-usage`), no error classification, no backoff or retry (one subcode-specific retry in `clone-ad-campaign`). Many sequential calls from cron plus a human clicking in the app share one token and one rate bucket.
- No batch API, no async insights jobs, no `breakdowns`, `date_preset`, `action_attribution_windows`, `use_unified_attribution_setting` (attribution windows are Meta's default; keep this in mind when comparing numbers across tools).
- No pagination in `run-campaign-control` and `clone-ad-campaign` (first page only, inferred).
- No Conversions API / Pixel health checks, no webhooks, no `debug_token` or token refresh; tokens simply expire.
- No spend ceiling in `update-ad-entity` or `clone-ad-campaign`; per-product caps exist only in the pipeline's own tables.

## What the official MCP could add beyond this (if the account is enabled)

| Capability | Value for the shop | Overlap |
|---|---|---|
| Meta-side benchmarks (industry, auction ranking), anomaly signal, performance trend, opportunity score | New: compares us with the market, not only with our own baseline. Good input for the coach, as a human-read report. | none in code |
| Dataset (pixel / Conversions API) quality, event stats, errors | New. Matters when a goal is VALUE or purchase (`bio_pro_orange`); messaging campaigns need it less. | none |
| Product catalog tools | Not needed today (orders go through Pancake POS and the web checkout); possible later for catalog ads. | none |
| Create campaign / ad set / ad, update, activate | Already done better by `launch-ad` (templates, welcome message, `targetingOverride`, video, `degrees_of_freedom_spec`). | full |
| Live reads without waiting for the daily sync | Convenience only. | partial |

Conclusion: the official MCP does not replace any pipeline function and cannot upload media or delete. Its value is the analysis tools in the first two rows, used by a person.

## Join point guidance (Facebook MCP → Pipeline)

- Keep `ads-test-auto` on direct Graph calls. If a later chat wants Meta benchmarks inside the pipeline, call the Marketing API / Insights endpoints from Deno rather than an MCP, because the MCP login is user-bound and enablement is gated.
- Anything new the pipeline needs from Facebook should be added to a shared helper with header-based rate-limit handling, instead of a fourth copy of `gget`/`fbPost`.
