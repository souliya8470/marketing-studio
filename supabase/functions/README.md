# Edge functions

The deployed copy in Supabase is the source of truth. Files here are snapshots kept for history and for new chats.

| Function | Snapshot here | Deployed version |
|---|---|---|
| ads-test-auto | `ads-test-auto/index.ts` | v9 (manual_go: owner-pressed launch bypasses auto_launch/window; v8 promo price overrides list price) |
| launch-ad | not exported yet | v30 |
| ads-template-inspect | not exported yet | v1 |
| ads-research | not exported yet | v1 |
| ads-playbook | not exported yet | v7 |

To fetch one that is not exported: `get_edge_function` (project `swrijpkkufarddsyqhrh`, slug = function name).
After every deploy, copy the deployed source here and update this table.
