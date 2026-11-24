// Supabase Edge Function: ads-test-variants (v1, 2026-11-24, Sykhai Editor -> ad tests)
// Tar: "AI writes THREE captions (different selling angles) so I can pick; I do not know which angle suits which video; no 450-character limit".
// Separate from ads-test-auto (v9, left untouched on purpose: it runs the daily pipeline). Copies its helpers; merge later if wanted.
//   action "send" (default): body { edited_video_id (edited_product_videos.id), product_key, promo_state: "none"|"has_promo", promo_text?, asset_id (uuid made by the UI; frames are stored as
//        <product_key>/frames/<asset_id>_N.jpg), frames: string[] (public urls), transcript? }
//        -> inserts product_assets (source 'upload' because of check constraint product_assets_source_chk (upload|facebook); the origin is written in note, storage_path 'edited:<id>' so deleting the asset never deletes the finished video; status 'queued' so the cron planner skips it),
//           lets Claude judge the video + choose THREE selling angles (pain/result/offer/routine/curiosity/trust) and write one long caption per angle (parallel),
//           inserts ad_test_plans status 'proposed' (review-first: nothing is launched here). plan.caption/headline = the recommended variant; plan.ai.variants = all of them (+ variant_index).
//   action "regen": body { plan_id } -> writes a fresh set of 3 variants for a still-"proposed" plan.
// Secrets: ANTHROPIC_API_KEY (optional ADS_COACH_MODEL). verify_jwt: true.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const META_TOKEN = Deno.env.get("META_ACCESS_TOKEN") ?? "";
const MODEL = Deno.env.get("ADS_COACH_MODEL") ?? "claude-sonnet-5-5";
const THAI_SCRIPT = /[\u0E00-\u0E7F]/;
const GARBLE = /\uFFFD|\b(MUST|SHOULD|TODO|NOTE)\b/;
const RISKY = /ຮັກສາ|ປິ່ນປົວ|ຫາຍຂາດ|ຫາຍດີ|ເບົາຫວານ|ຄວາມດັນ|ມະເຮັງ|ການັນຕີ|ຮັບປະກັນ|100\s*%/;
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
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const laosToday = () => new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);

// ---------- promo rules (v6) ----------
const normPromo = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
// the promo the owner currently runs for this product ("" = none); expired promos count as none
function activePromo(cfg: any): string | null {
  const t = String(cfg?.current_promo ?? "").trim();
  if (!t) return null;
  if (cfg.promo_until && String(cfg.promo_until).slice(0, 10) < laosToday()) return null;
  return t;
}
const PROMO_WORDS = /ແຖມ|ໂປຣ|ຟຣີ|ສ່ວນຫຼຸດ|ລາຄາພິເສດ|ຫຼຸດລາຄາ/;

function b64(u8: Uint8Array): string {
  let s = ""; const C = 0x8000;
  for (let i = 0; i < u8.length; i += C) s += String.fromCharCode(...u8.subarray(i, i + C));
  return btoa(s);
}
const badText = (t: unknown) => { const s = typeof t === "string" ? t : JSON.stringify(t); return THAI_SCRIPT.test(s) || GARBLE.test(s); };

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

const ANGLES = ["pain", "result", "offer", "routine", "curiosity", "trust"] as const;
const ANGLE_HELP = `pain = open with the customer's real everyday problem and make them feel understood; result = the feeling / change a customer hopes for (soft, never a medical claim or guarantee); offer = lead with the current_promo (ONLY allowed when current_promo is given); routine = how it fits into a normal day / how to take it, easy and simple; curiosity = an intriguing question or surprising fact taken from the data; trust = who it is for, what is in it, why choose this shop (only facts from the data).`;

const PROMO_RULE = `PROMO RULE: the data field current_promo is the ONLY promotion you may mention (gift, discount, bundle deal, special price, limited time). If current_promo is null, write NO promotion at all: no gift, no discount, no "promo", no free items, no special price. Never copy a promotion from best_past_ads, recent captions, the playbook or from the picture itself; those may be old. When current_promo is given, you may state it in your own words but never change its items, amounts or dates, and never add anything to it. If current_promo states a price, that is the ONLY price you may write; ignore any other price in the data. If the picture or video frames visibly show a promotion that differs from current_promo, set usable=false and say so in reject_reason_lo.`;
const PLAYBOOK_RULE = `If the data has sales_playbook, it was written for this product and approved by the owner: follow its big_idea_lo, pick or adapt ONE hook from hooks to what the file actually shows (do not copy a hook that does not fit the picture), follow caption_formula_lo, use offer_lo exactly as written (never change prices or add promos), and never use anything listed in avoid or do_not_use_until_confirmed (these are unconfirmed or forbidden claims). Still vary the angle from the recent captions.`;

const REVIEW_SYSTEM = BASE + `

YOUR JOB: you receive the product facts, the shop's best past ads, recent test captions, and a few snapshot frames (or one picture) of ONE file the shop wants to test as a Facebook ad. Answer ONLY by calling the tool.
1. Judge the file. usable=false only when it clearly cannot work as an ad: unreadable (blurry/very dark), shows a different product, shows before/after body results or medical claims, nudity, a child as the focus, or nothing related to the product. Explain in reject_reason_lo. Do NOT reject a file for being plain. Give hook_score 1-5 honestly (1 = nothing stops the scroll, 5 = a very strong first second).
2. If usable, the shop will test THREE different ad texts on this file and the owner does not know which selling angle suits which video. Choose the THREE angles from this menu that fit WHAT THE FILE ACTUALLY SHOWS best and are clearly different from each other (and from recent_test_captions_to_avoid_repeating): ${ANGLE_HELP}
For each angle give: key (from the menu), title_lo (the angle name in a few Lao words), why_lo (ONE short Lao sentence: why this angle suits THIS video: what is on screen or said in it), headline_lo (the ad headline, at most 60 characters, hook of that angle). Mark exactly one angle recommended=true: the one you expect to work best on this video. Do NOT write the long ad text here; a second step writes it.
If a transcript field is given, it is what the presenter says and shows on screen in the video: use it to choose angles that match the video's real message.
shows_lo: one sentence on what you see. fits_lo: one sentence on how it fits the product and who it appeals to. angle_lo: the recommended angle, a few words.
${PLAYBOOK_RULE}
${PROMO_RULE}
Without a transcript you cannot hear audio and frames are only snapshots: never claim what is said in a video. If no frames are given, say so in shows_lo and choose angles only from the product facts.`;

const REVIEW_TOOL = {
  name: "submit_review", description: "Submit the review of the file and the three chosen selling angles.",
  input_schema: { type: "object", required: ["usable", "shows_lo", "hook_score", "angles"], properties: {
    usable: { type: "boolean" }, reject_reason_lo: { type: "string" }, shows_lo: { type: "string" },
    hook_score: { type: "integer", minimum: 1, maximum: 5 }, fits_lo: { type: "string" }, angle_lo: { type: "string" },
    angles: { type: "array", maxItems: 3, description: "exactly 3 objects when usable=true (always required); an empty array when usable=false", items: { type: "object", required: ["key", "title_lo", "why_lo", "headline_lo"], properties: {
      key: { type: "string", enum: [...ANGLES] }, title_lo: { type: "string" }, why_lo: { type: "string" }, headline_lo: { type: "string" }, recommended: { type: "boolean" },
    } } },
  } },
};

// step 2 (v10): one caption per chosen angle, written in parallel (Lao is token-heavy; three long texts in one answer would be slow and could be cut off)
const CAPTION_SYSTEM = BASE + `

YOUR JOB: write ONE Facebook ad primary text (the caption) for a Lao online shop, for ONE selling angle on ONE video. You get the product facts, the angle, what the video shows, the planned headline, optional transcript of the video, the shop's best past ads and recent captions. Answer ONLY by calling the tool.
- LENGTH (this overrides the line "Keep every field SHORT" above, for the caption only): there is no short limit. Write as long as the message needs to be complete and persuasive, usually 300 to 900 characters, never padded and never more than 1500. Do not cut a thought in half to stay short.
- STRUCTURE: the first two lines (about 125 characters) are what people see before "see more": put the hook and the core promise of the angle there. Then short paragraphs with line breaks. End with one clear call to action to message the page (for example ທັກແຊັດ ເພື່ອສັ່ງຊື້ / ສອບຖາມ). A few emoji are fine.
- The text must match the angle, must fit what the video shows and says, and must differ from recent_test_captions_to_avoid_repeating.
${PLAYBOOK_RULE}
${PROMO_RULE}
If the angle is "offer" and current_promo is null, write the "routine" angle instead and say so in note_lo.`;
const CAPTION_TOOL = {
  name: "submit_caption", description: "Submit the ad primary text.",
  input_schema: { type: "object", required: ["caption_lo"], properties: { caption_lo: { type: "string" }, note_lo: { type: "string" } } },
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
  const transcript = asset.transcript ? clip(asset.transcript, 3500) : undefined;
  const payload = {
    file_kind: asset.kind, file_name: asset.file_name, frames_available: images.length,
    product_label: cfg.label, product: (promoHasPrice && facts.product) ? { ...facts.product, price_kip: null, price_note: "current_promo states the selling price: write only that price" } : facts.product, pain_points: facts.pains, faq: facts.faq, knowledge: facts.knowledge,
    sales_playbook: facts.playbook || undefined,
    current_promo: activePromo(cfg),
    transcript,
    best_past_ads: facts.best, recent_test_captions_to_avoid_repeating: (recent || []).map((r: any) => ({ caption: clip(r.caption, 160), headline: r.headline })),
  };
  content.push({ type: "text", text: "Data (JSON):\n" + JSON.stringify(payload) });

  const textProblem = (c: string, h: string): string | null => {
    if (RISKY.test(c) || RISKY.test(h)) return "risky claim word: " + ((c + " " + h).match(RISKY) || [])[0];
    if (!activePromo(cfg) && PROMO_WORDS.test(c + " " + h)) return "promo or gift wording while no current promo is set: " + ((c + " " + h).match(PROMO_WORDS) || [])[0];
    return null;
  };
  const check = (o: any): string | null => {
    if (typeof o.usable !== "boolean") return "usable missing";
    if (badText(o)) return "Thai script or broken characters";
    if (o.usable) {
      const an = Array.isArray(o.angles) ? o.angles : [];
      if (an.length !== 3) return "exactly 3 angles are required";
      if (new Set(an.map((x: any) => x.key)).size !== 3) return "the 3 angles must have 3 different keys";
      if (!activePromo(cfg) && an.some((x: any) => x.key === "offer")) return "angle offer is not allowed while no current promo is set";
      for (const x of an) {
        const h = String(x.headline_lo || "").trim();
        if (!h || !String(x.title_lo || "").trim() || !String(x.why_lo || "").trim()) return "an angle misses headline, title or why";
        if (h.length > 60) return "headline longer than 60 characters";
        const p = textProblem("", h); if (p) return p;
      }
    }
    return null;
  };
  let tokens = 0;
  let r = await callClaude(REVIEW_SYSTEM, content, REVIEW_TOOL, 2500);
  tokens += r.inTok + r.outTok;
  let problem = check(r.out);
  if (problem) {
    const retry = [...content, { type: "text", text: `Your previous answer was rejected: ${problem}. Fix it. Call the tool again and ALWAYS fill the angles array with exactly 3 objects (key, title_lo, why_lo, headline_lo, recommended). Clean Lao script only, exactly 3 different angles from the menu, headline at most 60 characters, no risky claims, and no promotion or gift unless current_promo is given.` }];
    r = await callClaude(REVIEW_SYSTEM, retry, REVIEW_TOOL, 2500);
    tokens += r.inTok + r.outTok;
    problem = check(r.out);
  }
  if (problem || !r.out.usable) return { out: r.out, problem, tokens, frames_used: images.length, variants: [] as any[] };

  // step 2: one long caption per angle, three calls in parallel
  const o = r.out;
  let recIdx = o.angles.findIndex((x: any) => x.recommended === true); if (recIdx < 0) recIdx = 0;
  const base = { ...payload }; // no pictures needed: the angle + what the video shows carry the meaning
  const writeOne = async (x: any, i: number) => {
    const body = (extra = "") => [{ type: "text", text: "Data (JSON):\n" + JSON.stringify({ ...base, angle: { key: x.key, title_lo: x.title_lo, why_lo: x.why_lo }, planned_headline_lo: String(x.headline_lo).trim(), video_shows_lo: o.shows_lo, video_fits_lo: o.fits_lo }) + extra }];
    let t = 0, c = "", why: string | null = "no answer";
    for (let k = 0; k < 2; k++) {
      try {
        const res = await callClaude(CAPTION_SYSTEM, body(k ? `\n\nYour previous text was rejected: ${why}. Fix it: clean Lao script only, at most 1500 characters, no risky claims, no promotion or gift unless current_promo is given.` : ""), CAPTION_TOOL, 3500);
        t += res.inTok + res.outTok; c = String(res.out.caption_lo || "").trim();
        why = !c ? "caption empty" : c.length > 1500 ? "caption longer than 1500 characters" : badText(c) ? "Thai script or broken characters" : textProblem(c, String(x.headline_lo));
        if (!why) break;
      } catch (e) { why = errMsg(e); }
    }
    return { ok: !why, i, t, c, why, x };
  };
  const done = await Promise.all(o.angles.map((x: any, i: number) => writeOne(x, i)));
  const variants = done.filter((d) => d.ok).map((d) => ({ key: d.x.key, title_lo: String(d.x.title_lo).trim(), why_lo: String(d.x.why_lo).trim(), headline: String(d.x.headline_lo).trim(), caption: d.c, recommended: d.i === recIdx }));
  tokens += done.reduce((n, d) => n + d.t, 0);
  if (!variants.length) return { out: r.out, problem: "no caption passed the checks (" + done.map((d) => d.why).join("; ") + ")", tokens, frames_used: images.length, variants: [] as any[] };
  if (!variants.some((v) => v.recommended)) variants[0].recommended = true;
  return { out: r.out, problem: null as string | null, tokens, frames_used: images.length, variants };
}


const factsCache = new Map<string, any>();
const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function logIt(product_key: string, plan_id: string | null, action: string, detail: string) {
  try { await sb.from("ad_test_log").insert({ product_key, plan_id, action, detail: detail.slice(0, 1000) }); } catch (_e) { /* best-effort */ }
}
const reviewOf = (o: any, res: any, cfg: any) => ({ usable: !!o.usable && !res.problem, shows_lo: o.shows_lo || null, fits_lo: o.fits_lo || null, angle_lo: o.angle_lo || null, hook_score: o.hook_score ?? null, reject_reason_lo: o.reject_reason_lo || null, promo_used: activePromo(cfg), frames_used: res.frames_used, model: MODEL, tokens: res.tokens, problem: res.problem });
const variantsSummary = (vs: any[]) => vs.map((v) => ({ key: v.key, title_lo: v.title_lo, why_lo: v.why_lo, headline: v.headline, len: v.caption.length, recommended: !!v.recommended }));

async function sendVideo(b: any) {
  const vid = String(b.edited_video_id || ""), key = String(b.product_key || ""), pstate = String(b.promo_state || ""), assetId = String(b.asset_id || "");
  if (!ASSET_ID_RE.test(vid) || !ASSET_ID_RE.test(assetId)) return { ok: false, error: "edited_video_id / asset_id must be uuids" };
  if (!PRODUCT_ID[key]) return { ok: false, error: "unknown product_key" };
  if (pstate !== "none" && pstate !== "has_promo") return { ok: false, error: "promo_state must be none or has_promo" };
  const { data: cfg } = await sb.from("ad_test_products").select("*").eq("product_key", key).maybeSingle();
  if (!cfg || !cfg.enabled) return { ok: false, error: "product is not enabled for ad tests" };
  const { data: v } = await sb.from("edited_product_videos").select("*").eq("id", vid).maybeSingle();
  if (!v || v.is_deleted) return { ok: false, error: "finished video not found" };
  if (v.product_id !== PRODUCT_ID[key]) return { ok: false, error: "this video belongs to another product" };
  const path = "edited:" + vid;
  const { data: ex } = await sb.from("product_assets").select("id,status").eq("product_key", key).eq("storage_path", path).maybeSingle();
  if (ex) return { ok: false, error: "already_sent", asset_id: ex.id, status: ex.status };
  const ap = activePromo(cfg);
  let promoText: string | null = null;
  if (pstate === "has_promo") {
    promoText = String(b.promo_text || ap || "").trim();
    if (!ap) return { ok: false, error: "the video has a promo but no current promo is set for this product" };
    if (normPromo(promoText) !== normPromo(ap)) return { ok: false, error: "the promo in the video differs from the current promo" };
  }
  const frames: string[] = (Array.isArray(b.frames) ? b.frames : []).filter((u: any) => typeof u === "string" && u.startsWith(SUPABASE_URL)).slice(0, 3);
  const transcript = String(b.transcript || v.script || "").trim() || null;
  const row: any = {
    id: assetId, product_key: key, kind: "video", storage_path: path, public_url: v.public_url, file_name: String(v.title || v.file_name || "").slice(0, 200),
    size_bytes: v.size_bytes, note: "ຈາກ Sykhai Editor · ອະນຸມັດໂດຍ " + (v.uploaded_by || ""), status: "queued", created_by: String(b.by || v.uploaded_by || "editor"),
    frames, source: "upload", thumb_url: v.thumb_url || null, promo_state: pstate, promo_text: promoText, promo_confirmed: true, transcript,
  };
  const { error: insErr } = await sb.from("product_assets").insert(row);
  if (insErr) return { ok: false, error: "insert asset: " + insErr.message };
  const undo = async () => { try { await sb.from("product_assets").delete().eq("id", assetId); } catch (_e) { /* */ } };
  let res: any;
  try { res = await reviewAsset(row, cfg); } catch (e) { await undo(); return { ok: false, error: "AI: " + errMsg(e) }; }
  const o = res.out, review = reviewOf(o, res, cfg);
  if (res.problem) { // technical failure of the AI answer (not a verdict on the video): leave nothing behind so the owner can simply press the button again
    await undo();
    return { ok: false, error: "AI answer failed the checks: " + res.problem };
  }
  if (!o.usable) {
    const why = res.problem ? "ຂໍ້ຄວາມທີ່ AI ຂຽນບໍ່ຜ່ານການກວດ (" + res.problem + ")" : (o.reject_reason_lo || "AI ເຫັນວ່າໃຊ້ເປັນແອັດບໍ່ໄດ້");
    review.reject_reason_lo = why;
    await sb.from("product_assets").update({ status: "retired", ai_review: review }).eq("id", assetId);
    await logIt(key, null, "asset_rejected", `${row.file_name}: ${why}`);
    return { ok: false, rejected: why, asset_id: assetId };
  }
  const pick = res.variants.find((x: any) => x.recommended) || res.variants[0];
  const { data: ins, error } = await sb.from("ad_test_plans").insert({
    plan_date: laosToday(), product_key: key, asset_id: assetId, caption: pick.caption, headline: pick.headline,
    daily_budget: Number(cfg.budget_per_test), status: "proposed", ai: { ...review, variants: res.variants, variant_index: res.variants.indexOf(pick), source: "sykhai-editor", edited_video_id: vid },
  }).select("id").single();
  if (error) { await undo(); return { ok: false, error: "insert plan: " + error.message }; }
  await sb.from("product_assets").update({ ai_review: review }).eq("id", assetId);
  await logIt(key, ins.id, "planned", `${row.file_name}: hook ${review.hook_score}/5 · 3 variants · ${review.angle_lo || ""}`);
  return { ok: true, plan_id: ins.id, asset_id: assetId, hook_score: review.hook_score, variants: variantsSummary(res.variants) };
}

async function regen(b: any) {
  const planId = String(b.plan_id || "");
  if (!ASSET_ID_RE.test(planId)) return { ok: false, error: "plan_id must be a uuid" };
  const { data: plan } = await sb.from("ad_test_plans").select("*").eq("id", planId).maybeSingle();
  if (!plan) return { ok: false, error: "plan not found" };
  if (plan.status !== "proposed") return { ok: false, error: "only a plan that is still proposed can be rewritten" };
  const { data: cfg } = await sb.from("ad_test_products").select("*").eq("product_key", plan.product_key).maybeSingle();
  const { data: asset } = plan.asset_id ? await sb.from("product_assets").select("*").eq("id", plan.asset_id).maybeSingle() : { data: null };
  if (!cfg || !asset) return { ok: false, error: "product or file not found" };
  const res = await reviewAsset(asset, cfg);
  if (res.problem || !res.out.usable) return { ok: false, error: "AI: " + (res.problem || res.out.reject_reason_lo || "not usable") };
  const review = reviewOf(res.out, res, cfg);
  const pick = res.variants.find((x: any) => x.recommended) || res.variants[0];
  const { error } = await sb.from("ad_test_plans").update({ caption: pick.caption, headline: pick.headline, ai: { ...(plan.ai || {}), ...review, variants: res.variants, variant_index: res.variants.indexOf(pick), regenerated_at: new Date().toISOString() } }).eq("id", planId).eq("status", "proposed");
  if (error) return { ok: false, error: "update plan: " + error.message };
  await logIt(plan.product_key, planId, "regen", "3 new variants");
  return { ok: true, plan_id: planId, variants: variantsSummary(res.variants) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  T0 = Date.now(); factsCache.clear();
  try {
    if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY missing" }, 500);
    const b = await req.json().catch(() => ({}));
    const out = String(b.action || "send") === "regen" ? await regen(b) : await sendVideo(b);
    return json(out, out.ok ? 200 : 200);
  } catch (e) { return json({ ok: false, error: errMsg(e) }, 500); }
});
