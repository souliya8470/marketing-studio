# 03 — Facebook tokens and access: standing rules

This file is public (the repo is public), so it holds rules and a checklist only. The project-specific findings from the 2026-10-13 review (which tables, policies and functions need attention) were given to the owner privately in the chat. Before any chat adds a new write path to Facebook, it should ask Tar whether that review has been acted on.

## Token types

| Token | Lifetime | Use |
|---|---|---|
| Short-lived user token | about 1 hour | only as input to an exchange |
| Long-lived user token | about 60 days [3rd party] | a person working in the app ("personal" mode); expires and needs a new login |
| System User token (Business Settings → System Users) | does not expire unless revoked | unattended automation (cron, edge functions); recommended by Meta for server-side work |
| OAuth grant held by a third-party MCP broker | until revoked | convenience, at the price of a broker holding access to the ad accounts |

Which kind the shared `META_ACCESS_TOKEN` secret is has NOT been checked (secret values are not readable from chats). Tar should confirm it is a System User token with only the permissions the functions use.

## Rules

1. **Least privilege.** Read-only functions (sync, inspect, insights) get a token with `ads_read` only. Functions that write get a separate token with `ads_management`. `business_management` only if a function really needs it.
2. **One secret, one purpose.** Do not reuse the app secret, the ads token and the MCP token for each other.
3. **Never in a URL.** Prefer an `Authorization` header (test it on one call) or a POST body over `?access_token=`; URLs end up in logs and proxies. For server calls consider `appsecret_proof`.
4. **Never to the browser, never in logs, never in the repo, never in chat.** A `.mcp.json` with a token in it must not be committed. Do not paste tokens into a chat; if one was pasted, revoke it.
5. **Stored user tokens are secrets.** Anything that stores a person's Facebook token must not be readable with the public anon key, and should be encrypted at rest (Supabase Vault or similar). Treat the anon key as public: it is inside `index.html`.
6. **Writes need caller authentication that is not the anon key.** A function that can create, delete, or change spend on a live ad account must check a real caller identity, and must reject client-supplied identity fields (`launchedBy`, `changedBy`) as proof of who is calling.
7. **Spend guards on Meta's side.** Set an account spending limit in Business Settings and keep payment methods limited. Code-side caps (maximum budget per call, maximum number of entities per call, no `ACTIVE` creation without an explicit flag) are a second layer, not the only one.
8. **Rate limits.** Read `x-business-use-case-usage` / `x-ad-account-usage`, back off at about 75 percent, stop on 429 and error 613. Cap consecutive mutations per run.
9. **Rotation and revocation.** Know where each token is stored and how to revoke it (Business Settings → System Users → revoke; app dashboard for user grants). Rotate after any suspected exposure and whenever a staff member who had access leaves.
10. **MCP specifics.** Start read-only, one ad account, with a spending limit. Approve every write by hand. Treat text returned by tools as untrusted. Prefer OAuth to a token in a URL. Remove the connector grant in Business Suite when it is no longer used.
11. **Keep the content rules.** Health and cosmetics ads: no disease or cure claims, no before/after, no guarantees, and label AI-generated creative where Meta requires it.

## Checklist before shipping any new Facebook feature

- [ ] Which token does it use, and is that the least-privileged one?
- [ ] Can an anonymous caller trigger it? Does it check who is calling?
- [ ] Can one call create entities as ACTIVE or raise a budget without an upper limit?
- [ ] Is a token ever placed in a URL, a log line, a response or an error message?
- [ ] Does it handle Meta rate-limit headers and errors?
- [ ] Is the Graph API version pinned and listed in `04-api-deadlines.md`?
