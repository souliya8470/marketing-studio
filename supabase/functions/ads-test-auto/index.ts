// Supabase Edge Function: ads-test-auto (v9)
// v9 (2026-10-13): plan.ai.manual_go = the owner pressed "launch" on a plan in the UI: launchStage launches it even when the product is
//     review-first (ad_test_products.auto_launch = false) and outside the launch window (full template copy, same path as auto launches).
// v8 (2026-10-13): when current_promo states a price, product.price_kip is dropped from the caption data (the shop's list price can differ from the advertised price).
// v6 (2026-10-13): PROMO RULES + REUSE OF OLD WINNERS.
//     - ad_test_products.current_promo / promo_until: the ONLY promo the caption writer may mention. No current promo
//       (or expired) = captions must contain no gift/discount/promo wording (code check + retry).
//     - product_assets.promo_state (none | has_promo | unknown), promo_text, promo_confirmed: a file with a promo inside
//       is used only while its promo_text equals the current promo; otherwise it is skipped (stays "new").
//     - new action "import": copies the best OLD ads of a product (video_id / image_url from ad_creatives, same ad account
//       as the template, ranked by cost per message) into product_assets (source='facebook'). Claude makes a first guess
//       whether a promo is visible ON the thumbnail (v7 deploy: only the picture counts, caption-only hints give "unknown").
//       Imported files wait until the owner confirms the promo tag.
//     - launch of an imported video reuses the Facebook video_id (no upload). If the promo changed between plan and launch
//       the plan is rejected and the file goes back to "new".
// v5 (2026-10-13): an APPROVED sales playbook (product_playbooks.status='approved') is passed to the caption writer
//     (big idea, offer, hooks, caption formula, things to avoid, unconfirmed items). Without one, behaviour is unchanged.
// v4 (2026-10-12): the legacy `standard_enhancements` bundle in the template's creative enhancements is dropped when copying
//     (Facebook rejects it with subcode 3858504; the individual features are still copied); retry-without-enhancements also
//     matches that error.
// v3 (2026-10-12): launches now COPY THE TEMPLATE CAMPAIGN FULLY, as Ads Manager shows it: the whole ad set targeting
//     (Advantage+ placements/audience, excluded countries, brand-safety...), the saved Messenger welcome-message template,
//     Instagram identity and creative enhancements. New action "template" (read-only summary of what will be copied),
//     new flag create_paused (launch everything PAUSED, for a controlled test). ANTHROPIC key only needed for plan/tick/judge.
// v2: per-request state reset (a warm isolate kept T0/report/caches from the previous call).
// Marketing Studio "Ads Coach" stage 2: the automatic daily test pipeline.
// One call = one "tick" (cron runs it every 10 minutes). A tick does, in this order:
//   1. JUDGE  - running tests older than 3 days get a verdict (wait / winner / loser) from real numbers.
//               Code gates decide what is ALLOWED; Claude explains and may only be more careful. A clear loser is PAUSED.
//   2. PLAN   - new files in product_assets are looked at by Claude (vision: frames / picture) and get a caption,
//               headline and a usable/not-usable review. Slots are limited by the product's daily cap.
//   3. LAUNCH - approved plans are created on Facebook through the existing launch-ad function (ACTIVE+SCHEDULED
//               a few minutes ahead), only inside the product's launch window (Laos hours), video upload is
//               resumable across ticks.
// Budget is never increased here. Winners stay as they are; Tar decides about scaling.
// Body: { action?: "tick"|"plan"|"judge"|"template"|"import", product_keys?: string[], per_product?: number, dry_run?: boolean, force_launch?: boolean, create_paused?: boolean }
// Secrets: ANTHROPIC_API_KEY, META_ACCESS_TOKEN, optional ADS_COACH_MODEL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const META_TOKEN = Deno.env.get("META_ACCESS_TOKEN") ?? "";
const MODEL = Deno.env.get("ADS_COACH_MODEL") ?? "claude-sonnet-5-5";
const THAI_SCRIPT = /[\u0E00-\u0E7F]/;
const GARBLE = /\uFFFD|\b(MUST|SHOULD|TODO|NOTE)\b/;
const RISKY = /ຮັກສາ|ປິ່ນປົວ|ຫາຍຂາດ|ຫາຍດີ|ເບົາຫວານ|ຄວາມດັນ|ມະເຮັງ|ການັນຕີ|ຮັບປະກັນ|100\s*%/;
const GRAPH = "https://graph.facebook.com/v21.0";

const PRODUCT_ID: Record<string, string> = {
  bio_pro_orange: "p1783144544466", toby_magnesium: "p1783147254115", tirdian_plus: "p1783400050860",
  veggie_coffee: "p_yumiko_veggie_coffee", sesame_coffee: "p_pimnada_sesame_coffee", velaris_lung: "p1783146396263",
};

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
let T0 = Date.now();
const BUDGET_MS = 100_000;
const timeLeft = () => BUDGET_MS - (Date.now() - T0);
const HOUR = 3600e3, DAY = 86400e3;
const clip = (s: any, n: number) => (s == null ? null : String(s).slice(0, n));
const errMsg = (e: any) => String(e?.message || e).slice(0, 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const laosHour = () => new Date(Date.now() + 7 * HOUR).getUTCHours();
const laosMidnightUtcIso = () => new Date(Math.floor((Date.now() + 7 * HOUR) / DAY) * DAY - 7 * HOUR).toISOString();
const laosToday = () => new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);
const laosDDMM = () => { const d = new Date(Date.now() + 7 * HOUR); return String(d.getUTCDate()).padStart(2, "0") + "/" + String(d.getUTCMonth() + 1).padStart(2, "0"); };

// ---------- promo rules (v6) ----------
const normPromo = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
// the promo the owner currently runs for this product ("" = none); expired promos count as none
function activePromo(cfg: any): string | null {
  const t = String(cfg?.current_promo ?? "").trim();
  if (!t) return null;
  if (cfg.promo_until && String(cfg.promo_until).slice(0, 10) < laosToday()) return null;
  return t;
}
// may this file be used today? (reason when not)
function assetEligibility(a: any, cfg: any): { ok: boolean; why?: string } {
  if (a.source === "facebook" && !a.promo_confirmed) return { ok: false, why: "promo tag not confirmed by owner" };
  if (a.promo_state === "has_promo") {
    const ap = activePromo(cfg);
    if (!ap) return { ok: false, why: "file shows a promo but no current promo is set" };
    if (normPromo(a.promo_text) !== normPromo(ap)) return { ok: false, why: "file promo differs from the current promo" };
    return { ok: true };
  }
  if (a.promo_state === "none") return { ok: true };
  // unknown: own uploads are assumed promo-free, imported old ads are not
  return a.source === "facebook" ? { ok: false, why: "promo tag unknown" } : { ok: true };
}
const PROMO_WORDS = /ແຖມ|ໂປຣ|ຟຣີ|ສ່ວນຫຼຸດ|ລາຄາພິເສດ|ຫຼຸດລາຄາ/;

function b64(u8: Uint8Array): string {
  let s = ""; const C = 0x8000;
  for (let i = 0; i < u8.length; i += C) s += String.fromCharCode(...u8.subarray(i, i + C));
  return btoa(s);
}
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const badText = (t: unknown) => { const s = typeof t === "string" ? t : JSON.stringify(t); return THAI_SCRIPT.test(s) || GARBLE.test(s); };

// ---------- run context (report + dry run) ----------
let DRY = false;
let CREATE_PAUSED = false;
let report: any = { actions: [], warnings: [], judged: [], planned: [], launched: [], skipped: [] };
const factsCache = new Map<string, any>();
const templateCache = new Map<string, any>();
async function L(product_key: string | null, plan_id: string | null, action: string, detail: string) {
  report.actions.push({ product_key, plan_id, action, detail: detail.slice(0, 300) });
  if (DRY) return;
  try { await sb.from("ad_test_log").insert({ product_key, plan_id, action, detail: detail.slice(0, 1000) }); } catch (_e) { /* best-effort */ }
}

// ---------- calls to other edge functions ----------
async function callFn(name: string, body: unknown, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(5000, Math.min(timeoutMs, timeLeft() + 15000)));
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    let data: any; try { data = JSON.parse(txt); } catch (_e) { data = { raw: txt.slice(0, 300) }; }
    if (!r.ok || data?.ok === false) throw new Error(`${name}: ${data?.error || data?.message || data?.raw || r.status}`);
    return data;
  } finally { clearTimeout(t); }
}

// ---------- Facebook Graph (read-only) ----------
async function gget(path: string, params: Record<string, string>) {
  if (!META_TOKEN) throw new Error("META_ACCESS_TOKEN missing");
  const qs = new URLSearchParams({ ...params, access_token: META_TOKEN });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(`${GRAPH}/${path}?${qs}`, { signal: ctl.signal });
    const j = await r.json();
    if (j.error) throw new Error(`graph ${path.split("/").pop()}: ${String(j.error.message || "").slice(0, 200)}`);
    return j;
  } finally { clearTimeout(t); }
}

// ---------- Claude ----------
async function callClaude(system: string, content: any[], tool: any, maxTokens = 3000) {
  let inTok = 0, outTok = 0, thinkingOff = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgContent = attempt > 0 ? [...content, { type: "text", text: "You must answer by calling the " + tool.name + " tool." }] : content;
    const base: Record<string, unknown> = { model: MODEL, max_tokens: maxTokens, system, tools: [tool], messages: [{ role: "user", content: msgContent }] };
    const send = (b: Record<string, unknown>) => fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(b) });
    let res = await send(thinkingOff ? { ...base, thinking: { type: "disabled" } } : base);
    let j = await res.json();
    if (!res.ok && thinkingOff && /thinking/i.test(JSON.stringify(j))) { thinkingOff = false; res = await send(base); j = await res.json(); }
    if (!res.ok) throw new Error("Anthropic API " + res.status + ": " + JSON.stringify(j?.error ?? j).slice(0, 300));
    inTok += Number(j.usage?.input_tokens || 0); outTok += Number(j.usage?.output_tokens || 0);
    if (j.stop_reason === "max_tokens") throw new Error("Claude response truncated");
    const block = (j.content || []).find((b: any) => b.type === "tool_use" && b.name === tool.name);
    if (block && block.input && typeof block.input === "object") return { out: block.input as any, inTok, outTok };
  }
  throw new Error("No valid tool_use from Claude");
}

const BASE = `You work for a Lao online shop (cosmetics and health supplements; customers message the Facebook page and pay cash on delivery).

LANGUAGE: all text fields must be natural, correct Lao script with the right tone marks. No Thai script, no Thai words, no English words except product names. Product names, numbers and prices stay as given. Write like a real Lao seller talking to a customer, short lines, a few emoji are fine. Keep every field SHORT: Lao uses many tokens. Re-read each field before submitting and fix any broken or stray characters.

COMPLIANCE (Facebook rules and honesty): never say or imply the product cures, treats or prevents a disease or condition; no before/after claims; no guarantees (100%, guaranteed results); do not say it is safe for people with a medical condition such as blood pressure or diabetes. Use ONLY facts that appear in the data: do not invent or add ingredients, counts, numbers, awards, certificates, testimonials, delivery times, free-shipping or return promises, stock, discounts or promo prices. If the data does not say it, do not write it. Say benefits softly ("ຊ່ວຍບຳລຸງ", "ເປັນສ່ວນໜຶ່ງຂອງການດູແລສຸຂະພາບ").`;

const REVIEW_SYSTEM = BASE + `

YOUR JOB: you receive the product facts, the shop's best past ads, recent test captions, and a few snapshot frames (or one picture) of ONE file the shop wants to test as a Facebook ad. Answer ONLY by calling the tool.
1. Judge the file. usable=false only when it clearly cannot work as an ad: unreadable (blurry/very dark), shows a different product, shows before/after body results or medical claims, nudity, a child as the focus, or nothing related to the product. Explain in reject_reason_lo. Do NOT reject a file for being plain. Give hook_score 1-5 honestly (1 = nothing stops the scroll, 5 = a very strong first second).
2. If usable, write caption_lo (the primary text, at most 450 characters) and headline_lo (at most 40 characters) that fit WHAT THE FILE ACTUALLY SHOWS and speak to one real customer pain point from the list. Use an angle different from the recent captions. Start with a hook line.
If the data has sales_playbook, it was written for this product and approved by the owner: follow its big_idea_lo, pick or adapt ONE hook from hooks to what the file actually shows (do not copy a hook that does not fit the picture), follow caption_formula_lo, use offer_lo exactly as written (never change prices or add promos), and never use anything listed in avoid or do_not_use_until_confirmed (these are unconfirmed or forbidden claims). Still vary the angle from the recent captions.
shows_lo: one sentence on what you see. fits_lo: one sentence on how it fits the product and who it appeals to. angle_lo: the angle you chose, a few words.
PROMO RULE: the data field current_promo is the ONLY promotion you may mention (gift, discount, bundle deal, special price, limited time). If current_promo is null, write NO promotion at all: no gift, no discount, no "promo", no free items, no special price. Never copy a promotion from best_past_ads, recent captions, the playbook or from the picture itself; those may be old. When current_promo is given, you may state it in your own words but never change its items, amounts or dates, and never add anything to it. If current_promo states a price, that is the ONLY price you may write; ignore any other price in the data. If the picture or video frames visibly show a promotion that differs from current_promo, set usable=false and say so in reject_reason_lo.
You cannot hear audio and frames are only snapshots: never claim what is said in a video. If no frames are given, say so in shows_lo and write only from the product facts.`;

const REVIEW_TOOL = {
  name: "submit_review", description: "Submit the review of the file and the ad text.",
  input_schema: { type: "object", required: ["usable", "shows_lo", "hook_score"], properties: {
    usable: { type: "boolean" }, reject_reason_lo: { type: "string" }, shows_lo: { type: "string" },
    hook_score: { type: "integer", minimum: 1, maximum: 5 }, fits_lo: { type: "string" }, angle_lo: { type: "string" },
    caption_lo: { type: "string" }, headline_lo: { type: "string" },
  } },
};

const JUDGE_SYSTEM = `You analyse ONE running Facebook test ad for a Lao online shop (messages objective: customers message the page; the shop's real orders are tracked elsewhere). You get its numbers, the shop's baseline for the same product, and a list allowed_verdicts that was computed by fixed rules. Answer ONLY by calling the tool.
- verdict must be one of allowed_verdicts. Use "wait" if the numbers are too thin or mixed even if another verdict is allowed.
- reason_lo: one or two short sentences in Lao that cite the real numbers (cost per message vs baseline, link CTR, messages).
- next_step_lo: ONE concrete change for the next test, chosen from what the numbers show: a weak hook (low CTR or low video hold), a caption angle, a different file, or "keep waiting". Never suggest raising budget, promises, discounts or medical claims.
LANGUAGE: natural, correct Lao script, no Thai script, no English except numbers and units. Short.`;
const JUDGE_TOOL = {
  name: "submit_verdict", description: "Submit the verdict for the test ad.",
  input_schema: { type: "object", required: ["verdict", "reason_lo", "next_step_lo"], properties: {
    verdict: { type: "string", enum: ["wait", "winner", "loser"] }, reason_lo: { type: "string" }, next_step_lo: { type: "string" },
  } },
};

// ---------- product facts ----------
async function loadFacts(key: string) {
  if (factsCache.has(key)) return factsCache.get(key);
  const pid = PRODUCT_ID[key];
  let product: any = null, pains: string[] = [], faq: any[] = [], knowledge: string | null = null;
  if (pid) {
    const { data: p } = await sb.from("products").select("name,price,description,painpoints,highlights,benefits,usage_info").eq("id", pid).maybeSingle();
    product = p;
    const { data: pp } = await sb.from("pain_points").select("text").eq("product_id", pid).limit(30);
    pains = (pp || []).map((r: any) => r.text);
    const { data: f } = await sb.from("product_faq").select("question,answer").eq("product_id", pid).limit(12);
    faq = (f || []).map((r: any) => ({ q: clip(r.question, 200), a: clip(r.answer, 300) }));
    const { data: k } = await sb.from("product_knowledge").select("content").eq("product_id", pid).limit(1);
    knowledge = clip(k?.[0]?.content, 1500);
  }
  // best past ads of the shop (non-test campaigns) for wording reference
  const { data: maps } = await sb.from("campaign_product_map").select("campaign_id,source").eq("product_key", key);
  const baseIds = (maps || []).filter((m: any) => m.source !== "ad_test").map((m: any) => m.campaign_id);
  let best: any[] = []; let baseline: any = null;
  if (baseIds.length) {
    const { data: perf } = await sb.from("ad_perf_window").select("ad_id,spend,purchases,purchase_value,messages,link_ctr").eq("window_days", 30).in("campaign_id", baseIds.slice(0, 150));
    const rows = (perf || []).filter((p: any) => Number(p.spend) >= 300);
    const cpm = rows.filter((p: any) => Number(p.messages) > 0).map((p: any) => Number(p.spend) / Number(p.messages));
    const lc = rows.filter((p: any) => p.link_ctr != null).map((p: any) => Number(p.link_ctr));
    baseline = { cost_per_message: median(cpm), link_ctr_pct: median(lc), ads_used: rows.length };
    const ids = rows.map((p: any) => p.ad_id);
    const { data: cre } = ids.length ? await sb.from("ad_creatives").select("ad_id,body,title").in("ad_id", ids.slice(0, 150)) : { data: [] as any[] };
    const cm = new Map((cre || []).map((c: any) => [c.ad_id, c]));
    const seen = new Set<string>();
    best = rows.filter((p: any) => cm.get(p.ad_id)?.body)
      .map((p: any) => ({ caption: clip(cm.get(p.ad_id)!.body, 500), headline: clip(cm.get(p.ad_id)!.title, 80), roas30: Number(p.spend) > 0 ? Math.round((Number(p.purchase_value) / Number(p.spend)) * 100) / 100 : 0, spend30: Math.round(Number(p.spend)) }))
      .sort((a: any, b: any) => b.roas30 - a.roas30)
      .filter((a: any) => { const k = (a.caption || "").slice(0, 100); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 3);
  }
  let playbook: any = null;
  try {
    const { data: pb } = await sb.from("product_playbooks").select("content,status").eq("product_key", key).eq("status", "approved").maybeSingle();
    const c = pb?.content;
    if (c) {
      playbook = {
        big_idea_lo: clip(c.big_idea_lo, 300), offer_lo: clip(c.offer_lo, 400), caption_formula_lo: clip(c.caption_formula_lo, 400),
        hooks: (c.hooks || []).slice(0, 12).map((h: any) => clip(h?.text_lo, 90)),
        audiences: (c.audiences || []).slice(0, 3), core_pains_lo: (c.core_pains_lo || []).slice(0, 5),
        avoid: (c.avoid || []).slice(0, 10),
        do_not_use_until_confirmed: [...(c.confirm_questions_lo || []), ...(c.conflicts_lo || [])].slice(0, 12).map((x: any) => clip(String(x), 200)),
      };
    }
  } catch (_e) { playbook = null; }
  const out = { product: product ? { name: product.name, price_kip: product.price, description: product.description, highlights: product.highlights, benefits: product.benefits, usage: product.usage_info, painpoints_field: product.painpoints } : null, pains, faq, knowledge, best, baseline, playbook };
  factsCache.set(key, out);
  return out;
}

// ---------- settings ----------
async function autoOn(): Promise<boolean> {
  const { data } = await sb.from("ad_coach_settings").select("value").eq("key", "auto_test_enabled").maybeSingle();
  return Number(data?.value ?? 0) === 1;
}

// ---------- committed budget ----------
async function committedFor(productKey: string): Promise<{ committed: number; pendingNew: number }> {
  const { data: plans } = await sb.from("ad_test_plans").select("status,daily_budget,campaign_id,launched_at").eq("product_key", productKey).in("status", ["proposed", "approved", "uploading", "launched", "judged"]);
  const rows = plans || [];
  const campIds = rows.filter((r: any) => (r.status === "judged") && r.campaign_id).map((r: any) => r.campaign_id);
  let active = new Set<string>();
  if (campIds.length) {
    const { data: cs } = await sb.from("ad_campaigns").select("id,status,effective_status,deleted_at").in("id", campIds);
    active = new Set((cs || []).filter((c: any) => !c.deleted_at && ["ACTIVE", "SCHEDULED", "WITH_ISSUES"].includes(String(c.effective_status || c.status))).map((c: any) => c.id));
  }
  let committed = 0, pendingNew = 0;
  const midnight = new Date(laosMidnightUtcIso()).getTime();
  for (const r of rows) {
    const b = Number(r.daily_budget || 0);
    if (["proposed", "approved", "uploading", "launched"].includes(r.status)) committed += b;
    else if (r.status === "judged" && r.campaign_id && active.has(r.campaign_id)) committed += b;
    if (["proposed", "approved", "uploading"].includes(r.status) || (r.launched_at && new Date(r.launched_at).getTime() >= midnight)) pendingNew++;
  }
  return { committed, pendingNew };
}

// =====================================================================
// 1. JUDGE
// =====================================================================
async function judgeStage(prodMap: Map<string, any>) {
  const { data: plans } = await sb.from("ad_test_plans").select("*").eq("status", "launched").not("ad_id", "is", null);
  const now = Date.now();
  const due = (plans || []).filter((p: any) => !p.last_checked_at || now - new Date(p.last_checked_at).getTime() > 20 * HOUR);
  if (!due.length) { report.skipped.push("judge: nothing due"); return; }

  if (!DRY) { try { await callFn("sync-ad-creative-insights", {}, 60000); } catch (e) { report.warnings.push("sync insights: " + errMsg(e)); } }

  const adIds = due.map((p: any) => p.ad_id);
  const campIds = [...new Set(due.map((p: any) => p.campaign_id).filter(Boolean))];
  const { data: perfRows } = await sb.from("ad_perf_window").select("*").in("ad_id", adIds);
  const { data: camps } = campIds.length ? await sb.from("ad_campaigns").select("id,campaign_name,status,effective_status,deleted_at").in("id", campIds) : { data: [] as any[] };
  const campMap = new Map((camps || []).map((c: any) => [c.id, c]));

  for (const p of due) {
    if (timeLeft() < 30000) { report.skipped.push("judge: out of time"); break; }
    const cfg = prodMap.get(p.product_key);
    const label = cfg?.label || p.product_key;
    const camp = campMap.get(p.campaign_id);
    const daysRunning = (now - new Date(p.launched_at).getTime()) / DAY;
    const days = Math.floor(daysRunning);
    const patch: any = { last_checked_at: new Date().toISOString() };

    // owner removed the campaign: close the plan, free the budget
    if (camp && (camp.deleted_at || ["DELETED", "ARCHIVED"].includes(String(camp.effective_status || camp.status)))) {
      if (!DRY) {
        await sb.from("ad_test_plans").update({ ...patch, status: "judged", verdict: "cancelled", verdict_reason: "ແອັດຖືກລົບ/ເກັບເຂົ້າຄັງ ໂດຍເຈົ້າຂອງ", judged_at: patch.last_checked_at }).eq("id", p.id);
        if (p.asset_id) await sb.from("product_assets").update({ status: "retired" }).eq("id", p.asset_id);
      }
      await L(p.product_key, p.id, "judge_cancelled", "campaign deleted/archived");
      continue;
    }

    const win = daysRunning <= 7 ? 7 : 30;
    const perf = (perfRows || []).find((r: any) => r.ad_id === p.ad_id && r.window_days === win) || (perfRows || []).find((r: any) => r.ad_id === p.ad_id);
    if (!perf || days < 2) {
      if (!DRY) await sb.from("ad_test_plans").update({ ...patch, verdict: "wait", verdict_reason: perf ? "ຫາກໍເລີ່ມແລ່ນ — ຍັງເກັບຂໍ້ມູນ" : "ຍັງບໍ່ມີຕົວເລກຈາກ Facebook" }).eq("id", p.id);
      await L(p.product_key, p.id, "judge_wait", `days=${days} perf=${perf ? "yes" : "none"}`);
      continue;
    }

    const facts = await loadFacts(p.product_key);
    const spend = Number(perf.spend || 0), msgs = Number(perf.messages || 0), impr = Number(perf.impressions || 0);
    const cpMsg = msgs > 0 ? spend / msgs : null;
    const bl = facts.baseline?.cost_per_message ?? null;
    const allowed: string[] = ["wait"];
    const loserGate = spend >= 250 && ((msgs === 0 && days >= 4) || (bl && cpMsg != null && msgs >= 1 && cpMsg > 2 * bl) || (days >= 7 && bl && cpMsg != null && cpMsg > 1.5 * bl) || (days >= 7 && msgs === 0));
    const winnerGate = days >= 5 && msgs >= 6 && bl && cpMsg != null && cpMsg <= 0.8 * bl;
    if (spend >= 150 && days >= 3) {
      if (loserGate) allowed.push("loser");
      if (winnerGate) allowed.push("winner");
    }
    const asset = p.asset_id ? (await sb.from("product_assets").select("kind,file_name,ai_review").eq("id", p.asset_id).maybeSingle()).data : null;
    const payload = {
      product: label, days_running: days, window_days: perf.window_days, allowed_verdicts: allowed,
      numbers: { spend_thb: Math.round(spend), impressions: impr, messages: msgs, cost_per_message_thb: cpMsg != null ? Math.round(cpMsg * 10) / 10 : null,
        link_ctr_pct: perf.link_ctr != null ? Math.round(Number(perf.link_ctr) * 100) / 100 : null, ctr_pct: perf.ctr != null ? Math.round(Number(perf.ctr) * 100) / 100 : null,
        frequency: perf.frequency, purchases_pixel: perf.purchases,
        video_hold25_pct: perf.video_p25 != null && impr > 0 ? Math.round((1000 * Number(perf.video_p25)) / impr) / 10 : null,
        avg_watch_sec: perf.avg_watch_sec },
      baseline_same_product: facts.baseline, file_kind: asset?.kind, caption: clip(p.caption, 400), headline: p.headline, hook_score_at_review: p.ai?.hook_score ?? null,
    };

    let verdict = "wait", reason = "", next = "", tokens = 0;
    try {
      let r = await callClaude(JUDGE_SYSTEM, [{ type: "text", text: "Data (JSON):\n" + JSON.stringify(payload) }], JUDGE_TOOL, 900);
      if (badText(r.out)) r = await callClaude(JUDGE_SYSTEM, [{ type: "text", text: "Data (JSON):\n" + JSON.stringify(payload) + "\n\nYour previous answer had Thai script or broken characters. Rewrite in clean Lao script only." }], JUDGE_TOOL, 900);
      tokens = r.inTok + r.outTok;
      if (badText(r.out)) { reason = "ເບິ່ງຕົວເລກໃນບັດນີ້ໄດ້ເລີຍ — ຂໍ້ຄວາມ AI ບໍ່ຜ່ານການກວດ"; next = ""; }
      else { reason = String(r.out.reason_lo || "").slice(0, 300); next = String(r.out.next_step_lo || "").slice(0, 300); if (allowed.includes(r.out.verdict)) verdict = r.out.verdict; }
    } catch (e) {
      report.warnings.push("judge claude: " + errMsg(e));
      await L(p.product_key, p.id, "judge_error", errMsg(e));
      if (!DRY) await sb.from("ad_test_plans").update({ last_checked_at: new Date(Date.now() - 19 * HOUR).toISOString() }).eq("id", p.id); // retry in ~1h
      continue;
    }

    report.judged.push({ plan: p.id, product: label, verdict, days, spend: Math.round(spend), msgs, cpMsg, baseline: bl, reason, next, tokens });
    if (verdict === "wait") {
      if (!DRY) await sb.from("ad_test_plans").update({ ...patch, verdict: "wait", verdict_reason: reason, next_step: next }).eq("id", p.id);
      await L(p.product_key, p.id, "judge_wait", reason);
    } else if (verdict === "winner") {
      if (!DRY) {
        await sb.from("ad_test_plans").update({ ...patch, status: "judged", verdict: "winner", verdict_reason: reason, next_step: next, judged_at: patch.last_checked_at }).eq("id", p.id);
        if (p.asset_id) await sb.from("product_assets").update({ status: "winner" }).eq("id", p.asset_id);
      }
      await L(p.product_key, p.id, "judge_winner", reason);
    } else {
      let paused = false;
      if (!DRY) {
        try {
          await callFn("update-ad-entity", { entityType: "campaign", entityId: p.campaign_id, action: "toggle_status", newStatus: "PAUSED", entityName: camp?.campaign_name || "", changedBy: "ads-test-auto" }, 40000);
          paused = true;
        } catch (e) { report.warnings.push("pause failed: " + errMsg(e)); await L(p.product_key, p.id, "pause_failed", errMsg(e)); }
      }
      const finalReason = reason + (!DRY && !paused ? " (⚠️ ຢຸດແອັດອັດຕະໂນມັດບໍ່ສຳເລັດ — ກະລຸນາກົດຢຸດເອງ)" : "");
      if (!DRY) {
        await sb.from("ad_test_plans").update({ ...patch, status: "judged", verdict: "loser", verdict_reason: finalReason, next_step: next, judged_at: patch.last_checked_at }).eq("id", p.id);
        if (p.asset_id) await sb.from("product_assets").update({ status: "loser" }).eq("id", p.asset_id);
      }
      await L(p.product_key, p.id, "judge_loser", (paused ? "paused; " : "") + reason);
    }
  }
}

// =====================================================================
// 2. PLAN (Claude vision)
// =====================================================================
function mediaTypeFor(url: string): string {
  const e = url.split("?")[0].split(".").pop()!.toLowerCase();
  return e === "png" ? "image/png" : e === "webp" ? "image/webp" : e === "gif" ? "image/gif" : "image/jpeg";
}
async function fetchImageB64(url: string, maxBytes: number): Promise<{ data: string; type: string } | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const u8 = new Uint8Array(await r.arrayBuffer());
    if (u8.length > maxBytes || u8.length < 200) return null;
    return { data: b64(u8), type: mediaTypeFor(url) };
  } catch (_e) { return null; }
}

async function reviewAsset(asset: any, cfg: any) {
  const facts = await loadFacts(cfg.product_key);
  const { data: recent } = await sb.from("ad_test_plans").select("caption,headline").eq("product_key", cfg.product_key).neq("status", "rejected").order("created_at", { ascending: false }).limit(8);
  const frameUrls: string[] = Array.isArray(asset.frames) ? asset.frames.filter((u: any) => typeof u === "string").slice(0, 3) : [];
  const images: { data: string; type: string }[] = [];
  for (const u of frameUrls) { const im = await fetchImageB64(u, 3_500_000); if (im) images.push(im); }
  if (!images.length && asset.kind === "image" && /\.(jpe?g|png|webp)$/i.test(String(asset.public_url).split("?")[0]) && Number(asset.size_bytes || 0) <= 4_500_000) {
    const im = await fetchImageB64(asset.public_url, 4_800_000); if (im) images.push(im);
  }
  const content: any[] = [];
  images.forEach((im, i) => {
    content.push({ type: "text", text: asset.kind === "video" ? `Frame ${i + 1} of ${images.length} from the video (spread across the video):` : "The picture:" });
    content.push({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } });
  });
  const promoNow = activePromo(cfg);
  const promoHasPrice = !!promoNow && /\d[\d,.\s]*(ກີບ|kip|₭)/i.test(promoNow);
  const payload = {
    file_kind: asset.kind, file_name: asset.file_name, frames_available: images.length,
    product_label: cfg.label, product: (promoHasPrice && facts.product) ? { ...facts.product, price_kip: null, price_note: "current_promo states the selling price: write only that price" } : facts.product, pain_points: facts.pains, faq: facts.faq, knowledge: facts.knowledge,
    sales_playbook: facts.playbook || undefined,
    current_promo: activePromo(cfg),
    best_past_ads: facts.best, recent_test_captions_to_avoid_repeating: (recent || []).map((r: any) => ({ caption: clip(r.caption, 160), headline: r.headline })),
  };
  content.push({ type: "text", text: "Data (JSON):\n" + JSON.stringify(payload) });

  const check = (o: any): string | null => {
    if (typeof o.usable !== "boolean") return "usable missing";
    if (badText(o)) return "Thai script or broken characters";
    if (o.usable) {
      const c = String(o.caption_lo || "").trim(), h = String(o.headline_lo || "").trim();
      if (!c || !h) return "caption or headline missing";
      if (c.length > 450) return "caption longer than 450 characters";
      if (h.length > 40) return "headline longer than 40 characters";
      if (RISKY.test(c) || RISKY.test(h)) return "risky claim word: " + ((c + " " + h).match(RISKY) || [])[0];
      if (!activePromo(cfg) && PROMO_WORDS.test(c + " " + h)) return "promo or gift wording while no current promo is set: " + ((c + " " + h).match(PROMO_WORDS) || [])[0];
    }
    return null;
  };
  let tokens = 0;
  let r = await callClaude(REVIEW_SYSTEM, content, REVIEW_TOOL, 2500);
  tokens += r.inTok + r.outTok;
  let problem = check(r.out);
  if (problem) {
    const retry = [...content, { type: "text", text: `Your previous answer was rejected: ${problem}. Fix it. Clean Lao script only, caption at most 450 characters, headline at most 40 characters, no risky claims, and no promotion or gift unless current_promo is given.` }];
    r = await callClaude(REVIEW_SYSTEM, retry, REVIEW_TOOL, 2500);
    tokens += r.inTok + r.outTok;
    problem = check(r.out);
  }
  return { out: r.out, problem, tokens, frames_used: images.length };
}

async function planStage(prods: any[], auto: boolean, only: string[] | null) {
  const today = laosToday();
  for (const cfg of prods) {
    if (only && !only.includes(cfg.product_key)) continue;
    if (!cfg.enabled) continue;
    if (timeLeft() < 30000) { report.skipped.push("plan: out of time"); break; }

    const { committed, pendingNew } = await committedFor(cfg.product_key);
    const perTest = Number(cfg.budget_per_test);
    let slots = Math.floor((Number(cfg.daily_cap) - committed + 1e-9) / perTest);
    slots = Math.min(slots, Number(cfg.max_new_per_day || 2) - pendingNew);
    if (slots <= 0) { report.skipped.push(`${cfg.product_key}: no slot (committed ${committed}/${cfg.daily_cap}, new today ${pendingNew}/${cfg.max_new_per_day})`); continue; }

    const { data: allNew } = await sb.from("product_assets").select("*").eq("product_key", cfg.product_key).eq("status", "new").order("created_at", { ascending: true }).limit(60);
    const blocked: Record<string, number> = {};
    const assets = (allNew || []).filter((x: any) => { const e = assetEligibility(x, cfg); if (!e.ok) blocked[e.why!] = (blocked[e.why!] || 0) + 1; return e.ok; }).slice(0, slots);
    for (const [why, n] of Object.entries(blocked)) report.skipped.push(`${cfg.product_key}: ${n} file(s) skipped — ${why}`);
    if (!assets.length) { report.skipped.push(`${cfg.product_key}: no usable new files`); continue; }

    for (const a of assets) {
      if (timeLeft() < 35000) { report.skipped.push("plan: out of time"); break; }
      let res: any;
      try { res = await reviewAsset(a, cfg); }
      catch (e) { await L(cfg.product_key, null, "plan_error", `${a.file_name}: ${errMsg(e)}`); report.warnings.push("review " + a.file_name + ": " + errMsg(e)); continue; }
      const o = res.out;
      const review = { usable: !!o.usable && !res.problem, shows_lo: o.shows_lo || null, fits_lo: o.fits_lo || null, angle_lo: o.angle_lo || null, hook_score: o.hook_score ?? null, reject_reason_lo: o.reject_reason_lo || null, promo_used: activePromo(cfg), frames_used: res.frames_used, model: MODEL, tokens: res.tokens, problem: res.problem };

      if (res.problem || !o.usable) {
        const why = res.problem ? "ຂໍ້ຄວາມທີ່ AI ຂຽນບໍ່ຜ່ານການກວດ (" + res.problem + ")" : (o.reject_reason_lo || "AI ເຫັນວ່າໃຊ້ເປັນແອັດບໍ່ໄດ້");
        review.reject_reason_lo = why;
        if (!DRY) await sb.from("product_assets").update({ status: "retired", ai_review: review }).eq("id", a.id);
        await L(cfg.product_key, null, "asset_rejected", `${a.file_name}: ${why}`);
        report.planned.push({ asset: a.file_name, rejected: why, review });
        continue;
      }
      const status = auto && cfg.auto_launch ? "approved" : "proposed";
      let planId: string | null = null;
      if (!DRY) {
        const { data: ins, error } = await sb.from("ad_test_plans").insert({
          plan_date: today, product_key: cfg.product_key, asset_id: a.id, caption: String(o.caption_lo).trim(), headline: String(o.headline_lo).trim(),
          daily_budget: perTest, status, ai: review,
        }).select("id").single();
        if (error) { report.warnings.push("insert plan: " + error.message); continue; }
        planId = ins.id;
        await sb.from("product_assets").update({ status: "queued", ai_review: review }).eq("id", a.id);
      }
      await L(cfg.product_key, planId, "planned", `${a.file_name}: hook ${review.hook_score}/5 · ${review.angle_lo || ""}`);
      report.planned.push({ asset: a.file_name, status, caption: o.caption_lo, headline: o.headline_lo, review });
    }
  }
}

// =====================================================================
// 2b. IMPORT old winners (v6)
// =====================================================================
const PROMO_GUESS_SYSTEM = `You help a Lao online shop reuse an OLD Facebook ad creative. You get the old ad's caption, headline and one thumbnail (a video frame or the picture). The caption and headline will be REWRITTEN for the new ad, so a promotion that appears only in them does not matter. What matters is whether the creative itself (the picture or the video) carries a promotion: text or graphics on the thumbnail such as a free gift, bundle, discount, special price or limited time. Answer ONLY by calling the tool.
- state: "has_promo" = a promotion is clearly visible ON the thumbnail or picture; "none" = nothing like that is visible and the caption/headline do not hint at one; "unknown" = nothing is visible on the thumbnail but the caption or headline mentions a promotion (a video may show or say it in later frames or in its voice-over, which you cannot see or hear), or the thumbnail is unreadable.
- promo_seen_lo: if has_promo, the promotion exactly as it is shown on the picture, in a few Lao words; otherwise an empty string.
- reason_lo: one short Lao sentence why.
LANGUAGE: natural, correct Lao script, no Thai script. Keep numbers as written.`;
const PROMO_GUESS_TOOL = {
  name: "submit_promo_guess", description: "Submit the promo guess.",
  input_schema: { type: "object", required: ["state", "reason_lo"], properties: {
    state: { type: "string", enum: ["none", "has_promo", "unknown"] }, promo_seen_lo: { type: "string" }, reason_lo: { type: "string" },
  } },
};
const normAcct = (a: any) => String(a ?? "").replace(/^act_/, "");

async function guessPromo(row: { body: string | null; title: string | null; frame: string | null }) {
  const content: any[] = [];
  if (row.frame) { const im = await fetchImageB64(row.frame, 3_500_000); if (im) { content.push({ type: "text", text: "Thumbnail:" }); content.push({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } }); } }
  content.push({ type: "text", text: "Old ad caption: " + String(row.body || "").slice(0, 700) + "\nOld ad headline: " + String(row.title || "").slice(0, 120) });
  const r = await callClaude(PROMO_GUESS_SYSTEM, content, PROMO_GUESS_TOOL, 600);
  const o = r.out;
  if (badText(o) || !["none", "has_promo", "unknown"].includes(o.state)) return { state: "unknown", promo_seen_lo: "", reason_lo: "", note: "AI answer unusable" };
  return { state: o.state, promo_seen_lo: String(o.promo_seen_lo || "").slice(0, 200), reason_lo: String(o.reason_lo || "").slice(0, 240) };
}

async function importStage(prods: any[], only: string[] | null, perProduct: number) {
  report.imported = [];
  for (const cfg of prods) {
    if (only && !only.includes(cfg.product_key)) continue;
    if (!cfg.enabled || !cfg.ad_account_id) continue;
    if (timeLeft() < 30000) { report.skipped.push("import: out of time"); break; }
    const { data: maps } = await sb.from("campaign_product_map").select("campaign_id,source").eq("product_key", cfg.product_key);
    const ids = (maps || []).filter((m: any) => m.source !== "ad_test").map((m: any) => m.campaign_id);
    if (!ids.length) { report.skipped.push(`${cfg.product_key}: no old campaigns`); continue; }
    // only ads of the SAME ad account as the template: Facebook videos cannot be reused across accounts
    const { data: camps } = await sb.from("ad_campaigns").select("id,ad_account_id").in("id", ids.slice(0, 300));
    const sameAcct = new Set((camps || []).filter((c: any) => normAcct(c.ad_account_id) === normAcct(cfg.ad_account_id)).map((c: any) => c.id));
    if (!sameAcct.size) { report.skipped.push(`${cfg.product_key}: no old campaigns in ad account ${cfg.ad_account_id}`); continue; }
    const { data: perf } = await sb.from("ad_perf_window").select("ad_id,campaign_id,spend,messages").eq("window_days", 30).in("campaign_id", [...sameAcct].slice(0, 200));
    const rows = (perf || []).filter((x: any) => Number(x.spend) >= 300 && Number(x.messages) >= 15)
      .map((x: any) => ({ ad_id: x.ad_id, spend: Number(x.spend), messages: Number(x.messages), cpm: Number(x.spend) / Number(x.messages) }))
      .sort((a: any, b: any) => a.cpm - b.cpm);
    if (!rows.length) { report.skipped.push(`${cfg.product_key}: no old ad with enough data (spend>=300, messages>=15, last 30 days)`); continue; }
    const { data: cre } = await sb.from("ad_creatives").select("ad_id,kind,body,title,video_id,image_url,thumbnail_url").in("ad_id", rows.map((r: any) => r.ad_id).slice(0, 200));
    const cm = new Map((cre || []).map((c: any) => [c.ad_id, c]));
    const { data: have } = await sb.from("product_assets").select("fb_ad_id,fb_video_id,public_url").eq("product_key", cfg.product_key).eq("source", "facebook");
    const haveAd = new Set((have || []).map((h: any) => h.fb_ad_id)), haveVid = new Set((have || []).map((h: any) => h.fb_video_id).filter(Boolean)), haveUrl = new Set((have || []).map((h: any) => h.public_url));
    const picks: any[] = [];
    for (const r of rows) {
      if (picks.length >= perProduct) break;
      const c: any = cm.get(r.ad_id);
      if (!c || haveAd.has(r.ad_id)) continue;
      if (c.kind === "video" && c.video_id) {
        if (haveVid.has(c.video_id)) continue;
        const thumb = c.thumbnail_url || c.image_url;
        if (!thumb) continue;
        haveVid.add(c.video_id);
        picks.push({ r, c, kind: "video", url: thumb, vid: c.video_id });
      } else if (c.kind === "image" && c.image_url) {
        if (haveUrl.has(c.image_url)) continue;
        haveUrl.add(c.image_url);
        picks.push({ r, c, kind: "image", url: c.image_url, vid: null });
      }
    }
    if (!picks.length) { report.skipped.push(`${cfg.product_key}: no new old creative to import (${rows.length} old ads checked)`); continue; }
    const guesses = await Promise.all(picks.map(async (p: any) => {
      try { return await guessPromo({ body: p.c.body, title: p.c.title, frame: p.kind === "video" ? p.url : p.url }); }
      catch (e) { return { state: "unknown", promo_seen_lo: "", reason_lo: "", note: errMsg(e) }; }
    }));
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i], g: any = guesses[i];
      const rec = {
        product_key: cfg.product_key, kind: p.kind, storage_path: "facebook:" + p.r.ad_id, public_url: p.url, file_name: "ແອັດເກົ່າ #" + String(p.r.ad_id).slice(-6),
        size_bytes: null, note: `ຈາກແອັດເກົ່າ: ຕົ້ນທຶນ/ແຊັດ ${Math.round(p.r.cpm)} · ໃຊ້ໄປ ${Math.round(p.r.spend)} · ${p.r.messages} ແຊັດ (30 ວັນ)`,
        status: "new", created_by: "ads-test-auto", frames: p.kind === "video" ? [p.url] : [],
        source: "facebook", fb_video_id: p.vid, fb_ad_id: p.r.ad_id, thumb_url: p.kind === "video" ? p.url : null,
        source_caption: clip(p.c.body, 1200), promo_state: "unknown", promo_text: null, promo_confirmed: false, promo_guess: g,
      };
      if (!DRY) {
        const { error } = await sb.from("product_assets").insert(rec);
        if (error) { report.warnings.push("import insert: " + error.message); continue; }
        await L(cfg.product_key, null, "asset_imported", `${rec.file_name} · ${g.state}${g.promo_seen_lo ? " · " + g.promo_seen_lo : ""}`);
      }
      report.imported.push({ product: cfg.product_key, ad_id: p.r.ad_id, kind: p.kind, cost_per_message: Math.round(p.r.cpm), guess: g });
    }
  }
}

// =====================================================================
// 3. LAUNCH
// =====================================================================

// Finds the saved welcome-message JSON inside a creative's object_story_spec.
function findWelcome(creative: any): string | null {
  const spec = creative?.object_story_spec;
  if (!spec) return null;
  for (const k of ["link_data", "video_data", "photo_data", "template_data"]) {
    const w = spec[k]?.page_welcome_message;
    if (w) return typeof w === "string" ? w : JSON.stringify(w);
  }
  return null;
}

function welcomeSummary(raw: string | null) {
  if (!raw) return null;
  let o: any = null; try { o = JSON.parse(raw); } catch (_e) { /* keep raw only */ }
  const strings = new Set<string>(); let templateId: string | null = null;
  const walk = (v: any, k = "") => {
    if (v == null) return;
    if (typeof v === "string") {
      if (/template_id/i.test(k)) templateId = v;
      else if (v.length > 1 && !/^(VISUAL|TEXT|text|welcome_message|autofill_message|\d+)$/.test(v)) strings.add(v);
    } else if (typeof v === "number") { if (/template_id/i.test(k)) templateId = String(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
    else if (typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(o);
  return { template_id: templateId, texts: [...strings].slice(0, 12).map((t) => clip(t, 300)), raw_chars: raw.length };
}

function summarizeTemplate(cfg: any, a: any, full: any) {
  const t = full.targeting || {};
  const geo = t.geo_locations || {}, exg = t.excluded_geo_locations || {};
  const posKeys = ["facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "threads_positions"];
  const positions: Record<string, any> = {};
  for (const k of posKeys) if (Array.isArray(t[k]) && t[k].length) positions[k] = t[k];
  const manual = Array.isArray(t.publisher_platforms) && t.publisher_platforms.length > 0;
  const dof = full.dof?.creative_features_spec || null;
  return {
    product_key: cfg.product_key, label: cfg.label, campaign_id: cfg.template_campaign_id, adset_id: a.id || full.adsetId, adset_name: full.adsetName,
    page_id: a.pageId, optimization_goal: full.optimizationGoal, destination_type: full.destinationType, bid_strategy: full.bidStrategy, bid_amount: full.bidAmount,
    placements: { mode: manual ? "manual" : "advantage_plus", publisher_platforms: t.publisher_platforms || null, positions, device_platforms: t.device_platforms || null },
    audience: {
      age_min: t.age_min ?? null, age_max: t.age_max ?? null, genders: t.genders || null,
      advantage_audience: t.targeting_automation?.advantage_audience ?? null,
      countries: geo.countries || null, regions: (geo.regions || []).length || 0, cities: (geo.cities || []).length || 0,
      excluded_countries: exg.countries || null,
      interests: (t.flexible_spec || []).reduce((n: number, f: any) => n + (f.interests || []).length, 0),
      custom_audiences: (t.custom_audiences || []).length, excluded_custom_audiences: (t.excluded_custom_audiences || []).length,
      brand_safety: t.brand_safety_content_filter_levels || null,
    },
    welcome: welcomeSummary(full.welcomeRaw),
    instagram_user_id: full.instagramUserId || null, instagram_actor_id_only: !full.instagramUserId && !!full.instagramActorId,
    creative_enhancements: dof ? Object.fromEntries(Object.entries(dof).map(([k, v]: any) => [k, v?.enroll_status ?? v])) : null,
    cta: a.ctaType || full.ctaType || null,
    copied_ad_id: full.adId || null,
  };
}

async function loadTemplate(cfg: any) {
  if (templateCache.has(cfg.product_key)) return templateCache.get(cfg.product_key);
  const ls = await callFn("list-campaign-adsets", { campaignId: cfg.template_campaign_id }, 40000);
  const sets = ls?.adSets || [];
  const src = sets.find((a: any) => a.effectiveStatus === "ACTIVE") || sets[0];
  if (!src) throw new Error("template campaign has no ad set");
  const pf = await callFn("get-adset-for-prefill", { adSetId: src.id, connectionMode: "system", launchedBy: "ads-test-auto" }, 40000);
  const a = pf?.adSet;
  if (!a || !a.pageId) throw new Error("template ad set has no page");

  // Full copy of what Ads Manager has: read the ad set and one of its ads straight from Facebook.
  const as = await gget(src.id, { fields: "name,targeting,optimization_goal,bid_strategy,bid_amount,destination_type" });
  if (!as.targeting || typeof as.targeting !== "object") throw new Error("template ad set has no targeting");
  const targeting = JSON.parse(JSON.stringify(as.targeting));
  delete targeting.age_range; // read-only helper field some responses carry
  const adsRes = await gget(`${src.id}/ads`, { fields: "id,name,effective_status,creative{id,instagram_user_id,instagram_actor_id,degrees_of_freedom_spec,object_story_spec,call_to_action_type}", limit: "10" });
  const ads: any[] = (adsRes.data || []).filter((x: any) => x.creative);
  const ad = ads.find((x) => x.effective_status === "ACTIVE" && x.creative.object_story_spec) || ads.find((x) => x.creative.object_story_spec) || ads[0];
  const cr = ad?.creative || {};
  // Facebook no longer accepts the old `standard_enhancements` bundle on new creatives (subcode 3858504): copy the individual features only.
  let dof: any = cr.degrees_of_freedom_spec && typeof cr.degrees_of_freedom_spec === "object" ? cr.degrees_of_freedom_spec : null;
  if (dof && dof.creative_features_spec && typeof dof.creative_features_spec === "object") {
    const feats = { ...dof.creative_features_spec };
    delete feats.standard_enhancements;
    dof = Object.keys(feats).length ? { creative_features_spec: feats } : null;
  }
  const full = {
    adsetId: src.id, adsetName: as.name, targeting, optimizationGoal: as.optimization_goal, destinationType: as.destination_type, bidStrategy: as.bid_strategy, bidAmount: as.bid_amount != null ? Number(as.bid_amount) / 100 : null,
    welcomeRaw: findWelcome(cr), instagramUserId: cr.instagram_user_id || null, instagramActorId: cr.instagram_actor_id || null,
    dof,
    ctaType: cr.call_to_action_type || null, adId: ad?.id || null,
  };
  const out = { ...a, full, summary: summarizeTemplate(cfg, { ...a, id: src.id }, full) };
  templateCache.set(cfg.product_key, out);
  return out;
}

// Resumable video upload. Returns { videoId, thumbnailImageHash, thumbnailUrl } when ready, or null when more ticks are needed.
async function advanceVideo(plan: any, asset: any, cfg: any): Promise<any | null> {
  const base = { adAccountId: cfg.ad_account_id, connectionMode: "system", launchedBy: "ads-test-auto" };
  const upd = async (patch: any) => { Object.assign(plan, patch); if (!DRY) await sb.from("ad_test_plans").update(patch).eq("id", plan.id); };
  const fv = (b: any, ms = 60000) => callFn("fb-upload-video", { ...base, ...b }, ms);

  if (!plan.upload_phase) {
    let size = Number(asset.size_bytes || 0);
    if (!size) { const h = await fetch(asset.public_url, { method: "HEAD" }); size = Number(h.headers.get("content-length") || 0); }
    if (!size) throw new Error("cannot determine video size");
    if (size > 200 * 1024 * 1024) throw new Error("video larger than 200MB");
    if (DRY) { report.skipped.push(`dry: would start video upload ${asset.file_name} (${size} bytes)`); return null; }
    const st = await fv({ action: "start", fileSize: size });
    await upd({ status: "uploading", upload_session_id: st.uploadSessionId, video_id: st.videoId, upload_offset: st.startOffset, upload_end: st.endOffset, upload_size: size, upload_phase: "transfer" });
    await L(plan.product_key, plan.id, "video_start", `${asset.file_name} ${Math.round(size / 1048576)}MB`);
  }
  if (DRY) return null;
  const CHUNK = 4 * 1024 * 1024;
  if (plan.upload_phase === "transfer") {
    let off = Number(plan.upload_offset), end = Number(plan.upload_end);
    while (off < end) {
      if (timeLeft() < 30000) { await L(plan.product_key, plan.id, "video_progress", `${Math.round((off / Number(plan.upload_size)) * 100)}% (continues next tick)`); return null; }
      const chunkEnd = Math.min(end, off + CHUNK);
      const r = await fetch(asset.public_url, { headers: { Range: `bytes=${off}-${chunkEnd - 1}` } });
      if (r.status !== 206) throw new Error("storage did not honour Range request (" + r.status + ")");
      const u8 = new Uint8Array(await r.arrayBuffer());
      if (u8.length !== chunkEnd - off) throw new Error("short chunk from storage");
      const t = await fv({ action: "transfer", uploadSessionId: plan.upload_session_id, startOffset: off, chunkBase64: b64(u8) }, 90000);
      off = Number(t.startOffset); end = Number(t.endOffset);
      await upd({ upload_offset: off, upload_end: end });
    }
    await fv({ action: "finish", uploadSessionId: plan.upload_session_id, title: plan.headline || "" });
    await upd({ upload_phase: "processing" });
    await L(plan.product_key, plan.id, "video_sent", "waiting for Facebook to process");
  }
  if (plan.upload_phase === "processing") {
    for (let i = 0; i < 4; i++) {
      const s = await fv({ action: "status", videoId: plan.video_id });
      if (s.ready) { await upd({ upload_phase: "ready" }); return { videoId: plan.video_id, thumbnailImageHash: s.thumbnailImageHash, thumbnailUrl: s.thumbnailUrl }; }
      if (s.videoStatus === "error") throw new Error("Facebook could not process the video");
      if (timeLeft() < 30000) return null;
      await sleep(6000);
    }
    return null;
  }
  if (plan.upload_phase === "ready") {
    const s = await fv({ action: "status", videoId: plan.video_id });
    if (s.ready) return { videoId: plan.video_id, thumbnailImageHash: s.thumbnailImageHash, thumbnailUrl: s.thumbnailUrl };
    return null;
  }
  return null;
}

// v6: an old ad's video already lives on Facebook (same ad account): reuse it, fresh thumbnail when Facebook gives one.
async function existingVideo(asset: any, cfg: any) {
  const vid = String(asset.fb_video_id);
  try {
    const s = await callFn("fb-upload-video", { adAccountId: cfg.ad_account_id, connectionMode: "system", launchedBy: "ads-test-auto", action: "status", videoId: vid }, 60000);
    if (s && (s.thumbnailImageHash || s.thumbnailUrl)) return { videoId: vid, thumbnailImageHash: s.thumbnailImageHash || null, thumbnailUrl: s.thumbnailUrl || null };
  } catch (e) { report.warnings.push("video status " + vid + ": " + errMsg(e)); }
  if (asset.thumb_url) return { videoId: vid, thumbnailImageHash: null, thumbnailUrl: asset.thumb_url };
  throw new Error("old video has no thumbnail");
}

async function launchOne(plan: any, cfg: any, inWindow: boolean) {
  const id8 = String(plan.id).slice(0, 8);
  // idempotency: a previous call may have created the ad but died before saving
  const { data: prev } = await sb.from("ad_launch_log").select("campaign_id,adset_id,ad_id").eq("success", true).like("adset_name", `%#${id8}`).limit(1);
  if (prev && prev.length) {
    if (!DRY) {
      await sb.from("ad_test_plans").update({ status: "launched", campaign_id: prev[0].campaign_id, adset_id: prev[0].adset_id, ad_id: prev[0].ad_id, launched_at: new Date().toISOString(), fail_reason: null }).eq("id", plan.id);
      if (plan.asset_id) await sb.from("product_assets").update({ status: "testing" }).eq("id", plan.asset_id);
    }
    await L(plan.product_key, plan.id, "launch_adopted", "ad already existed in launch log");
    return;
  }
  const { data: asset } = await sb.from("product_assets").select("*").eq("id", plan.asset_id).maybeSingle();
  if (!asset) throw new Error("asset was deleted");

  // v6: the promo may have changed since the caption was written (plans can wait for the next morning)
  if (plan.ai && Object.prototype.hasOwnProperty.call(plan.ai, "promo_used") && plan.status === "approved" && !plan.upload_phase) {
    const now = activePromo(cfg), then = plan.ai.promo_used;
    if (normPromo(now) !== normPromo(then) || !assetEligibility(asset, cfg).ok) {
      if (!DRY) {
        await sb.from("ad_test_plans").update({ status: "rejected", fail_reason: "promo changed before launch", ai: { ...plan.ai, promo_changed: true } }).eq("id", plan.id);
        await sb.from("product_assets").update({ status: "new" }).eq("id", plan.asset_id);
      }
      await L(plan.product_key, plan.id, "asset_rejected", "promo changed before launch; the file goes back to the waiting list");
      report.skipped.push(`${plan.product_key}: plan dropped, promo changed before launch`);
      return;
    }
  }

  let video: any = null;
  if (asset.kind === "video") {
    if (asset.fb_video_id) video = await existingVideo(asset, cfg);
    else {
      video = await advanceVideo(plan, asset, cfg);
      if (!video) return; // more ticks needed
    }
  }
  if (!inWindow) { report.skipped.push(`${plan.product_key}: ready but outside launch window`); return; }
  if (DRY) { report.launched.push({ plan: plan.id, dry: true, product: cfg.label }); return; }
  if (timeLeft() < 40000) { report.skipped.push("launch: out of time"); return; }

  const a = await loadTemplate(cfg);
  const T = a.full;
  let imageBase64: string | null = null;
  if (asset.kind === "image") {
    const r = await fetch(asset.public_url);
    if (!r.ok) throw new Error("cannot fetch image (" + r.status + ")");
    const u8 = new Uint8Array(await r.arrayBuffer());
    if (u8.length > 12_000_000) throw new Error("image larger than 12MB");
    imageBase64 = b64(u8);
  }
  const name = `${cfg.label} TEST ${laosDDMM()} #${id8}`;
  const capped = a.bidStrategy && a.bidStrategy !== "LOWEST_COST_WITHOUT_CAP";
  const startTime = CREATE_PAUSED ? null : new Date(Date.now() + 3 * 60e3).toISOString();
  const body: any = {
    connectionMode: "system", campaignObjective: "engagement", objective: "messages", performanceGoal: a.optimizationGoal || T.optimizationGoal || null,
    dailyBudget: Number(plan.daily_budget), budgetType: "abo",
    bidStrategy: capped ? a.bidStrategy : null, bidAmount: (capped && a.bidAmount != null) ? Number(a.bidAmount) : null,
    destinationType: (T.destinationType || a.destinationType) === "WHATSAPP" ? "whatsapp" : "messenger",
    pageWelcomeMessage: T.welcomeRaw || null, pixelId: null, websiteUrl: null,
    primaryText: plan.caption, headline: plan.headline || null,
    imageBase64, existingPostId: null, existingImageHash: null,
    videoId: video ? video.videoId : null, videoThumbnailImageHash: video ? video.thumbnailImageHash : null, videoThumbnailUrl: video ? video.thumbnailUrl : null,
    ctaType: a.ctaType || T.ctaType || null, ageMin: Number(a.ageMin) || 18, ageMax: Number(a.ageMax) || 65, gender: a.gender || "all",
    locations: a.locations || [], interests: a.interests || [], savedAudienceId: null,
    targetingOverride: T.targeting, instagramUserId: T.instagramUserId || null, degreesOfFreedomSpec: T.dof || null,
    mobileOnly: false, placementMode: "auto", placements: { facebook: [], instagram: [], messenger: [] },
    launchedBy: "ads-test-auto", assignedRuleId: null, startTime, templateId: null, templateName: null,
    adAccountId: cfg.ad_account_id, pageId: a.pageId, flowType: "new_campaign", campaignId: null, campaignName: name, adsetName: name,
  };
  let res: any;
  try { res = await callFn("launch-ad", body, 90000); }
  catch (e) {
    // creative enhancements are the one part Facebook may refuse on its own; launch-ad already removed the empty campaign
    if (body.degreesOfFreedomSpec && /3858504|degrees_of_freedom|creative_features|enhancement/i.test(errMsg(e)) && timeLeft() > 25000) {
      report.warnings.push("launch without creative enhancements: " + errMsg(e));
      await L(plan.product_key, plan.id, "launch_no_dof", errMsg(e));
      body.degreesOfFreedomSpec = null;
      res = await callFn("launch-ad", body, 90000);
    } else throw e;
  }
  await sb.from("ad_test_plans").update({ status: "launched", campaign_id: res.campaignId || null, adset_id: res.adsetId || null, ad_id: res.adId || null, launched_at: new Date().toISOString(), fail_reason: null, last_checked_at: null }).eq("id", plan.id);
  if (plan.asset_id) await sb.from("product_assets").update({ status: "testing" }).eq("id", plan.asset_id);
  if (res.campaignId) await sb.from("campaign_product_map").upsert({ campaign_id: res.campaignId, product_key: plan.product_key, product_name: cfg.label, source: "ad_test" }, { onConflict: "campaign_id" });
  await L(plan.product_key, plan.id, "launched", `${name} · ${plan.daily_budget}/day · ${CREATE_PAUSED ? "PAUSED (test)" : "starts " + String(startTime).slice(11, 16) + "Z"}`);
  report.launched.push({ plan: plan.id, campaign: res.campaignId, adset: res.adsetId, ad: res.adId, product: cfg.label, paused: CREATE_PAUSED });
}

async function launchStage(prodMap: Map<string, any>, force: boolean, only: string[] | null) {
  const h = laosHour();
  const { data: plans } = await sb.from("ad_test_plans").select("*").in("status", ["approved", "uploading"]).order("created_at", { ascending: true }).limit(10);
  let done = 0;
  for (const plan of (plans || [])) {
    if (only && !only.includes(plan.product_key)) continue;
    if (timeLeft() < 25000 || done >= 3) { report.skipped.push("launch: limit/time reached"); break; }
    const cfg = prodMap.get(plan.product_key);
    const manual = !!(plan.ai && plan.ai.manual_go); // v9: the owner pressed launch on this plan
    if (!cfg || !cfg.enabled || (!cfg.auto_launch && !manual)) continue;
    const inWindow = force || manual || (h >= Number(cfg.launch_from_hour) && h <= Number(cfg.launch_to_hour));
    // a plan that has not started uploading waits for the window; one already uploading keeps going
    if (!inWindow && plan.status === "approved") { report.skipped.push(`${plan.product_key}: waiting for launch window ${cfg.launch_from_hour}-${cfg.launch_to_hour}h (now ${h}h)`); continue; }
    // back off after a failure (30 minutes)
    if (plan.attempts > 0 && plan.last_checked_at && Date.now() - new Date(plan.last_checked_at).getTime() < 30 * 60e3) continue;
    done++;
    try { await launchOne(plan, cfg, inWindow); }
    catch (e) {
      const msg = errMsg(e);
      const attempts = Number(plan.attempts || 0) + 1;
      const fail = attempts >= 3;
      await L(plan.product_key, plan.id, fail ? "launch_failed" : "launch_retry", `attempt ${attempts}: ${msg}`);
      report.warnings.push(`launch ${plan.id.slice(0, 8)}: ${msg}`);
      if (!DRY) await sb.from("ad_test_plans").update({ attempts, fail_reason: msg, last_checked_at: new Date().toISOString(), ...(fail ? { status: "failed" } : {}) }).eq("id", plan.id);
    }
  }
}

// =====================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // a warm isolate serves many requests: reset all per-run state
  T0 = Date.now();
  report = { actions: [], warnings: [], judged: [], planned: [], launched: [], skipped: [] };
  factsCache.clear(); templateCache.clear();
  let locked = false;
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "tick");
    DRY = !!body.dry_run;
    CREATE_PAUSED = !!body.create_paused;
    const only: string[] | null = Array.isArray(body.product_keys) && body.product_keys.length ? body.product_keys : null;
    const force = !!body.force_launch;

    // read-only: what a launch will copy from the template campaign
    if (action === "template") {
      const { data: prods } = await sb.from("ad_test_products").select("*").order("product_key");
      const list = (prods || []).filter((p: any) => p.template_campaign_id && (!only || only.includes(p.product_key)));
      const out: any[] = [];
      for (const cfg of list) {
        try { const t = await loadTemplate(cfg); out.push(t.summary); }
        catch (e) { out.push({ product_key: cfg.product_key, label: cfg.label, error: errMsg(e) }); }
      }
      return json({ ok: true, templates: out });
    }

    if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY missing" }, 500);

    if (!DRY) {
      const nowIso = new Date().toISOString();
      const { data: got } = await sb.from("ad_test_state").update({ locked_until: new Date(Date.now() + 4 * 60e3).toISOString() }).eq("id", 1).or(`locked_until.is.null,locked_until.lt.${nowIso}`).select("id");
      if (!got || !got.length) return json({ ok: true, busy: true, message: "another run is in progress" });
      locked = true;
    }

    const { data: prods } = await sb.from("ad_test_products").select("*").order("product_key");
    const prodList = prods || [];
    const prodMap = new Map(prodList.map((p: any) => [p.product_key, p]));
    if (action === "import") {
      await importStage(prodList, only, Math.max(1, Math.min(6, Number(body.per_product) || 3)));
      report.action = action; report.dry_run = DRY; report.elapsed_ms = Date.now() - T0;
      return json({ ok: true, ...report });
    }
    const auto = await autoOn();
    report.auto = auto; report.dry_run = DRY; report.laos_hour = laosHour(); report.action = action;

    if (action === "tick" && !auto) {
      report.skipped.push("auto switch is OFF — nothing done");
    } else {
      if (action === "tick" || action === "judge") await judgeStage(prodMap);
      if (auto && !DRY) {
        // approve proposals of auto products (e.g. made by the old manual planner)
        const keys = prodList.filter((p: any) => p.enabled && p.auto_launch).map((p: any) => p.product_key);
        if (keys.length) await sb.from("ad_test_plans").update({ status: "approved" }).eq("status", "proposed").in("product_key", keys);
      }
      if (action === "tick" || action === "plan") await planStage(prodList, auto, only);
      if (action === "tick" && auto) await launchStage(prodMap, force, only);
    }

    report.elapsed_ms = Date.now() - T0;
    if (!DRY && action === "tick") {
      await sb.from("ad_test_state").update({ last_tick_at: new Date().toISOString(), last_tick_summary: { auto, laos_hour: report.laos_hour, judged: report.judged.length, planned: report.planned.length, launched: report.launched.length, warnings: report.warnings.slice(0, 5), skipped: report.skipped.slice(0, 6), elapsed_ms: report.elapsed_ms } }).eq("id", 1);
    }
    return json({ ok: true, ...report });
  } catch (e) {
    return json({ ok: false, error: errMsg(e), report }, 500);
  } finally {
    if (locked) { try { await sb.from("ad_test_state").update({ locked_until: null }).eq("id", 1); } catch (_e) { /* lock expires by itself */ } }
  }
});
