# Marketing Studio — rules for every Claude session

Owner: Tar (Souliya), Lao online shop (cosmetics/supplements, Facebook ads, Pancake POS).
App: single-file SPA `index.html` in this repo. `main` auto-deploys to marketing.touktashop.online.
Backend: Supabase project `swrijpkkufarddsyqhrh` (DB + Edge Functions). The Edge Functions' authoritative copy lives in Supabase.

## First thing in every new chat
1. `git pull` (or clone) so you have the latest `main`.
2. Read `HANDOFF.md`: current state, who owns what, open items. Work only inside your own section.
3. Before ending: update your section of `HANDOFF.md`, commit, push.

## Hard rules (from the owner)
- Every message to Tar is in correct Lao (no Thai script, correct spelling and tone marks). Proofread before sending.
- Every edit of `index.html` bumps `APP_VERSION` with the 3-slot rotation `APP_VERSION` / `APP_VERSION_PREV` / `APP_VERSION_PREV_OLDER`, keeping the old comment history. Minor version caps at .99, then X+1.00.
- Data-only changes (SQL, edge functions, docs) do not touch `index.html` and need no bump.
- Do not start the deferred Pancake bulk re-sync.
- Do not edit Tar's Facebook template text unasked.
- Commits end with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
  `Claude-Session: <session url>`

## Working in parallel (several chats at once)
- `index.html` is one file and every edit changes `APP_VERSION`: two chats editing it at the same time will conflict. Only one chat edits `index.html` at a time; other chats work on edge functions, SQL, research and docs.
- If two chats must both change code: separate branches, merge one after the other, rebase before merging.
- Chats cannot see each other. They share through: this repo (`HANDOFF.md`, `docs/`), the Supabase DB, and Claude memory (facts about Tar only).

## Tooling notes
- The sandbox cannot curl Supabase. Test edge functions with `net.http_post` from SQL (`execute_sql`) using the anon key that is already inside `index.html`, then read `net._http_response` by id in a separate query.
- Run `execute_sql` one statement at a time (multi-statement calls can return one result or be cancelled).
- Claude API from edge functions: tool_use only, `tool_choice` is not supported by the model, Lao output is token-heavy (split into parallel parts, large `max_tokens`).
- Facebook Marketing API: `standard_enhancements` is deprecated (subcode 3858504).
