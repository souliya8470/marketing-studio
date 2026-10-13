# HANDOFF — shared state between chats

Each chat edits ONLY its own section (plus "Join points" when it changes an interface). Date every change.
Last updated: 2026-10-13 (pipeline chat).

## 0. Where things live
| What | Where |
|---|---|
| App code | `index.html` (this repo, `main`) — currently v8.37 (another chat shipped 8.37: online order → POS bill FIFO cost) |
| Edge functions | Supabase (authoritative). Snapshot of `ads-test-auto` v5 in `supabase/functions/ads-test-auto/`. Fetch the others with `get_edge_function`: `launch-ad` v30, `ads-template-inspect` v1, `ads-research` v1, `ads-playbook` v7 |
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
  - Offered, not yet confirmed by Tar: reuse old winning videos/images (`ad_creatives.video_id` / `image_url`) with new AI captions as daily test ads, plus old-vs-new comparison and pause suggestions for bad old ads.
  - Waiting for Tar: total daily test-budget ceiling; whether old bad ads are auto-paused or he clicks.
  - Tar's template has a disease-claim line and a Thai quick reply (reported, not edited).
  - RLS is disabled on all public tables (pre-existing advisory; mention only, do not auto-apply).

## 2. Content chat (what to say / ad angles) — state
_Not started. Scope: content and direction for building ads (angles, hooks, captions, video ideas, per-product playbooks). Write findings in `docs/content/`. The result that the pipeline consumes is the APPROVED row in `product_playbooks`._

## 3. Facebook MCP chat — state
_Not started. Scope: how to connect a Facebook (Meta Ads) MCP, what it could do beyond the current Graph API calls in `launch-ad` / `ads-template-inspect`, security of tokens. Write findings in `docs/facebook-mcp/`._

## 4. Join points (interfaces between chats)
- Content → Pipeline: approved `product_playbooks.content` (big idea, offer, hooks, caption formula, avoid list). `ads-test-auto` reads it when writing captions.
- Facebook MCP → Pipeline: any new Facebook capability must be reachable from the edge functions (Deno) or documented as a separate manual tool; the pipeline currently talks to Facebook only through the Graph API in `launch-ad` and `ads-template-inspect`.
- Joining later: a chat (or the pipeline chat) reads `docs/content/` and `docs/facebook-mcp/`, then proposes the merged change. Do not edit another chat's section.
