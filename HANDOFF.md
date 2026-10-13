# HANDOFF — shared state between chats

Each chat edits ONLY its own section (plus "Join points" when it changes an interface). Date every change.
Last updated: 2026-10-13 (pipeline chat: section 1 + table rows in section 0 for v8.38 / promo rules; Facebook MCP chat edited section 3 earlier).

## 0. Where things live
| What | Where |
|---|---|
| App code | `index.html` (this repo, `main`) — currently v8.38 (pipeline chat: promo card + import of old winners in the 🧪 tab; 8.37 was another chat's POS FIFO cost) |
| Edge functions | Supabase (authoritative). Snapshot of `ads-test-auto` (deployed version 8) in `supabase/functions/ads-test-auto/`. Fetch the others with `get_edge_function`: `launch-ad` v30, `ads-template-inspect` v1, `ads-research` v1, `ads-playbook` v7 |
| Product facts / playbooks / research | DB tables `products`, `pain_points`, `product_faq`, `product_knowledge`, `product_playbooks` (draft/approved), `product_research` |
| Daily test pipeline config | DB tables `ad_test_products`, `ad_test_plans`, `ad_test_state`, `ad_coach_settings` (master switch `auto_test_enabled`) |

## 1. Pipeline chat (daily auto-test machine) — state
- pg_cron job 31 `ads-test-auto-tick` every 10 min: judge → plan → launch. Only the launch step is limited to the Laos-time window `launch_from_hour`..`launch_to_hour` (8..14 = 08:00–14:59). Approved plans outside the window wait for the next morning.
- Limits: max 3 launches per tick, 30 min back-off after a failure, 3 attempts; per product `daily_cap` 200, `budget_per_test` 100, `max_new_per_day` 2. Judge: needs ≥2 days of data, compares cost per message with the product baseline, pauses clear losers only, never raises budgets.
- Pilot products enrolled: sesame_coffee, veggie_coffee, velaris_lung, toby_magnesium, bio_pro_orange, lutein coffee (no `products` row yet — needs 5 short facts from Tar). sleep_patch is out of stock: no ads.
- Sales playbook (ຄູ່ມືການເວົ້າ) + web research exist (v8.35/8.36). A playbook affects captions only after Tar approves it.
- Open items:
  - bio_pro_orange (goal VALUE) and toby (MESSAGING_PURCHASE_CONVERSION, template campaign paused) never launched live through the pipeline.
  - No real files queued for any product yet; loser-pausing and video upload never run live.
  - DONE 2026-10-13 (v8.38 + edge v6/v7): PROMO RULES + REUSE OF OLD WINNERS.
    - `ad_test_products.current_promo` / `promo_until` = the ONLY promo AI may write in a caption; empty/expired = no gift/discount wording (code check + retry). Set in the 🎁 card of the 🧪 tab.
    - `product_assets.promo_state` (none/has_promo/unknown) + `promo_text` + `promo_confirmed`. A has_promo file is used only while `promo_text` = current promo; own uploads count as promo-free unless tagged. Rule lives in `assetEligibility()` (edge) and `adsTestAssetBlock()` (index.html) — keep both in sync.
    - Action `import` of `ads-test-auto` (button "📥 ດຶງແອັດເກົ່າທີ່ຂາຍດີ"): best old ads by cost per message (spend≥300, messages≥15, same ad account as the template) → `product_assets` (source 'facebook', `fb_video_id`, `fb_ad_id`, `thumb_url`, `promo_guess`). Claude only looks at the thumbnail; caption-only hints give "unknown". Tar must confirm the tag (✅ none / 🎁 = current promo / ✖ old promo → retired) before a file is used.
    - Launch reuses the Facebook `video_id` (no upload). If the promo changed between plan and launch the plan is rejected and the file returns to "new".
    - NEVER TESTED LIVE: reusing an old `video_id` in a new ad via launch-ad (videoId + thumbnailUrl) and fb-upload-video `status` on an old video; FB CDN thumbnail URLs may expire.
    - v8 edge (2026-10-13): when `current_promo` states a price ("...ກີບ"), `products.price` is NOT passed to the caption writer (list price can differ from the advertised price). Velaris `current_promo` = "ລາຄາ 179,000 ກີບ ສົ່ງຟຣີ ເກັບເງິນປາຍທາງ" (set by Tar's statement; the `products.price` 249,000 is not advertised).
  - Not built: old-vs-new comparison and pause suggestions for bad old ads.
  - Waiting for Tar: total daily test-budget ceiling; whether old bad ads are auto-paused or he clicks.
  - Tar's template has a disease-claim line and a Thai quick reply (reported, not edited).
  - RLS is disabled on all public tables (pre-existing advisory; mention only, do not auto-apply).

## 2. Content chat (what to say / ad angles) — state
_Not started. Scope: content and direction for building ads (angles, hooks, captions, video ideas, per-product playbooks). Write findings in `docs/content/`. The result that the pipeline consumes is the APPROVED row in `product_playbooks`._

## 3. Facebook MCP chat — state
_Research done 2026-10-13. Scope: how to connect a Facebook (Meta Ads) MCP, what it could do beyond the current Graph API calls, security of tokens. Findings in `docs/facebook-mcp/` (start with its `README.md`)._
- Verdict (updated 2026-10-13 after testing): the official Meta Ads MCP (`https://mcp.facebook.com/ads`) connects from a Claude custom connector with no Meta app. 36 of 39 ad accounts visible to the owner's login are enabled, 3 are not (one of them is the account with live ads, so use the DB mirror or the browser for it). Reads worked on 3 accounts. About 90 tools: ad-level metrics with breakdowns, creative and media upload, draft-mode create/publish, audiences, pixel/CAPI, A/B and lift tests, Meta benchmarks and opportunity score. No write tool was called.
- It is a supervised tool for Tar and chats, not part of the pipeline for now (login is bound to a person; the unattended Bearer-token path is untested). A chat must propose any write and wait for a clear yes; check which permission level the connector was granted.
- **Deadline 2026-10-27:** root `GET /?ids=...` is removed for all Graph versions; `sync-ad-creative-insights` v2 uses it. Needs a fix (details in `04-api-deadlines.md`). `v21.0`, pinned everywhere, is removed 2027-01-21.
- Token and access findings were given to Tar privately (public repo). Standing rules in `03-token-security.md`. Do not add a new Facebook write path before asking Tar about them.
- Open: type of `META_ACCESS_TOKEN` (System User or user token) unknown; only 11 of ~110 functions were read.

## 4. Join points (interfaces between chats)
- Content → Pipeline: approved `product_playbooks.content` (big idea, offer, hooks, caption formula, avoid list). `ads-test-auto` reads it when writing captions.
- Facebook MCP → Pipeline: any new Facebook capability must be reachable from the edge functions (Deno) or documented as a separate manual tool; the pipeline currently talks to Facebook only through the Graph API in `launch-ad` and `ads-template-inspect`.
- Facebook MCP → Pipeline (2026-10-13, no interface change): keep direct Graph calls in the edge functions. Correction: Facebook is also called by `ads-test-auto` (read-only), `sync-ad-spend`, `sync-ad-creative-insights`, `update-ad-entity`, `clone-ad-campaign`, `run-campaign-control`, `run-scheduled-ad-pause`, `fb-upload-video`, `fb-oauth-exchange` (list in `docs/facebook-mcp/02-graph-usage-and-gaps.md`). Dated API removals are in `docs/facebook-mcp/04-api-deadlines.md`.
- Joining later: a chat (or the pipeline chat) reads `docs/content/` and `docs/facebook-mcp/`, then proposes the merged change. Do not edit another chat's section.
