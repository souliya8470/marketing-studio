# 04 — Graph / Marketing API version deadlines

All Facebook code in this project pins `v21.0` (`launch-ad`, `ads-template-inspect`, `ads-test-auto`, `sync-ad-spend`, `update-ad-entity`, `sync-ad-creative-insights`, `clone-ad-campaign`, `run-campaign-control`, `run-scheduled-ad-pause`, `fb-upload-video`, `fb-oauth-exchange`). The latest version is v26.0 (announced 2026-07-29).

Sources: Meta's v26 announcement (read through a page summary, so open the original to confirm exact wording) and a third-party article on version expiry. Dates are as they were reported on 2026-10-13.

## Dated items

| Date | What | Impact here | Action |
|---|---|---|---|
| **2026-10-27** (all versions, including v21) | Root multi-id reads `GET /?ids=...` are removed, along with the `pretty`, `debug` and `date_format` parameters and legacy `ETag` handling | **`sync-ad-creative-insights` reads creatives with `/?ids=<up to 40 ad ids>&fields=creative{...}`; it will fail after this date.** Not seen in the other 10 functions read; the other ~100 were not checked. | Replace with `act_X/ads?fields=id,creative{...}&limit=...` (same pattern `sync-ad-spend` already uses for ads) or one `GET /{ad_id}` per ad, or the batch API. Search every deployed function for `?ids=` and `ids:`. |
| 2026-10-27 (all versions) | `story` removed from `messenger_positions`; poll-ad creatives rejected; `web_only` applink treatment blocked for Web+App campaigns; delivery-estimate fields `daily_outcomes_curve`, `budget_guardrail`, `estimate_dau` removed | `launch-ad` accepts manual Messenger placements and copies full `targeting` from a template; a template that lists `story` will silently lose that placement. Polls, Web+App and delivery estimates are not used. | After the date, run `ads-template-inspect` on the template campaign and compare placements. |
| **2027-01-21** | v21.0 removed | Every call pinned to `v21.0` is silently answered by the next version, with no error. | Move the pin to a current version (v25 or v26) after replaying the real calls against both and diffing the data, not just status codes. |
| 2026-09-24 (past) | v20.0 removed | No `v20.0` pin found in the 11 functions read. Unversioned calls use the app's default version in the App Dashboard. | Check the Meta app's default version setting. |

## Already known

- `standard_enhancements` in creative features is deprecated (error subcode 3858504); Image Expansion moved into `creative_features_spec`. Do not send `standard_enhancements`.
- v26: Advantage+ Audience needs `advantage_audience` set explicitly for housing, employment and financial-product categories only; not relevant to cosmetics and supplements.

## Suggested upgrade routine

1. List every `graph.facebook.com` call in every deployed function (one shared constant for the version, not 11 copies).
2. Replay read calls against v21 and v26; diff shapes and values.
3. Change the constant, deploy, copy the deployed source into `supabase/functions/` and update that README table.
4. Record the new version and date here.
