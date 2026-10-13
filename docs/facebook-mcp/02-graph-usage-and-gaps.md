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

## What the official MCP adds beyond this (tested 2026-10-13; full tool list in `01-options-and-setup.md`)

| Capability | Value for the shop | Overlap with current code |
|---|---|---|
| Meta-side benchmarks (industry, auction ranking), anomaly signal, performance trend, opportunity score | New: compares us with the market, not only with our own baseline. Good input for the coach as a report a person reads. | none |
| Ad-level metrics with breakdowns (placement, age, gender...), `time_increment`, filtering and sorting, at account / campaign / ad set / ad level | Live reads of exactly what Ads Manager shows, including breakdowns that `sync-ad-spend` does not store. | partial (`sync-ad-spend`, `sync-ad-creative-insights`) |
| Pixel / Conversions API quality, event stats, errors | New. Matters when a goal is VALUE or purchase; messaging campaigns need it less. | none |
| Activity log, Ad Library search, ad preview | New: who changed what and when; competitor ads; how an ad looks per placement. | none |
| A/B tests and conversion lift tests | New; the pipeline compares cost per message with a baseline instead. | none |
| Custom audiences, catalog tools | Not used today; possible later. | none |
| Create campaign / ad set / ad / creative, update, activate, media upload | Overlaps `launch-ad`. Draft mode stages objects for review instead of creating them live. Whether it supports the shop's welcome-message template and template cloning is not verified. | large |

Conclusion (revised): the official MCP is broader than third-party articles said, and it works on 36 of the 39 ad accounts visible to the owner's login. It is a strong supervised tool for analysis and for staging ads. It still should not replace pipeline functions yet, because the login is bound to a person, enablement is gated per account (one account with live ads is not enabled), and the unattended Bearer-token path was not tested.

## Join point guidance (Facebook MCP → Pipeline)

- Keep `ads-test-auto` on direct Graph calls for now. If a later chat wants Meta benchmarks inside the pipeline, call the Marketing API / Insights endpoints from Deno, or first test the MCP's Bearer-token path with a System User token; the OAuth login is user-bound and enablement is gated per account.
- Anything new the pipeline needs from Facebook should be added to a shared helper with header-based rate-limit handling, instead of a fourth copy of `gget`/`fbPost`.
