// Supabase Edge Function: ads-analyst (v1, 2026-11-26)
// "Analysis team" of the Marketing Studio AI ad team.
// Reads real numbers of the running ad tests (ad_test_plans + ad_perf_window + ad_creatives),
// computes per-angle (caption_index) and per-video (campaign) results in CODE, and asks Claude
// ONLY to explain them as short Lao lessons. Lessons are saved as status='draft' in ad_lessons:
// a human approves them before they are used by the shoot/edit/caption teams (stage 2).
// This function NEVER touches Facebook ads or budgets. Read + write to ad_lessons / ad_analyst_runs only.
// Body: { product_key?: string, dry_run?: boolean, force?: boolean }
// Secrets: ANTHROPIC_API_KEY, optional ADS_COACH_MODEL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ADS_COACH_MODEL") ?? "claude-sonnet-5-5";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const DAY = 86400e3, HOUR = 3600e3;
const THAI_SCRIPT = /[฀-๿]/;
const GARBLE = /�|\b(MUST|SHOULD|TODO|NOTE)\b/;
const RISKY = /ຮັກສາ|ປິ່ນປົວ|ຫາຍຂາດ|ຫາຍດີ|ເບົາຫວານ|ຄວາມດັນ|ມະເຮັງ|ການັນຕີ|ຮັບປະກັນ|100\s*%/;
const MIN_SPEND_FOR_AI = 300; // THB per product before we ask Claude for lessons
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const clip = (s: any, n: number) => (s == null ? null : String(s).slice(0, n));
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const num = (x: any) => Number(x || 0);
const errMsg = (e: any) => String(e?.message || e).slice(0, 400);
function median(a: number[]) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

type Agg = { spend: number; msgs: number; impr: number; ads: number; ctrW: number; linkW: number; watchW: number; watchN: number };
const newAgg = (): Agg => ({ spend: 0, msgs: 0, impr: 0, ads: 0, ctrW: 0, linkW: 0, watchW: 0, watchN: 0 });
function addAgg(a: Agg, p: any) {
  const imp = num(p.impressions);
  a.spend += num(p.spend); a.msgs += num(p.messages); a.impr += imp; a.ads++;
  a.ctrW += num(p.ctr) * imp; a.linkW += num(p.link_ctr) * imp;
  if (p.avg_watch_sec != null) { a.watchW += num(p.avg_watch_sec) * imp; a.watchN += imp; }
}
function fin(a: Agg) {
  return {
    ads: a.ads, spend_thb: Math.round(a.spend), messages: a.msgs, impressions: a.impr,
    cost_per_message_thb: a.msgs > 0 ? r1(a.spend / a.msgs) : null,
    ctr_pct: a.impr ? Math.round((a.ctrW / a.impr) * 100) / 100 : null,
    link_ctr_pct: a.impr ? Math.round((a.linkW / a.impr) * 100) / 100 : null,
    avg_watch_sec: a.watchN ? r1(a.watchW / a.watchN) : null,
  };
}
function confidenceOf(f: { spend_thb: number; messages: number }) {
  if (f.spend_thb >= 500 && f.messages >= 12) return "high";
  if (f.spend_thb >= 250 && f.messages >= 5) return "medium";
  return "low";
}

async function baselineFor(key: string) {
  const { data: maps } = await sb.from("campaign_product_map").select("campaign_id,source").eq("product_key", key);
  const ids = (maps || []).filter((m: any) => m.source !== "ad_test").map((m: any) => m.campaign_id).slice(0, 150);
  if (!ids.length) return null;
  const { data: perf } = await sb.from("ad_perf_window").select("spend,messages,link_ctr").eq("window_days", 30).in("campaign_id", ids);
  const rows = (perf || []).filter((p: any) => num(p.spend) >= 300);
  return {
    cost_per_message_thb: r1(median(rows.filter((p: any) => num(p.messages) > 0).map((p: any) => num(p.spend) / num(p.messages)))),
    link_ctr_pct: r1(median(rows.filter((p: any) => p.link_ctr != null).map((p: any) => num(p.link_ctr)))),
    ads_used: rows.length,
  };
}

async function analyseProduct(key: string, label: string, dry: boolean, force: boolean) {
  const out: any = { product_key: key, label };
  if (!force) {
    const { data: last } = await sb.from("ad_analyst_runs").select("created_at").eq("product_key", key).order("created_at", { ascending: false }).limit(1);
    if (last?.[0] && Date.now() - new Date(last[0].created_at).getTime() < 20 * HOUR) { out.skipped = "analysed <20h ago"; return out; }
  }
  const { data: plans } = await sb.from("ad_test_plans").select("id,caption_index,caption,headline,campaign_id,ad_id,status,verdict,launched_at,asset_id,daily_budget").eq("product_key", key).in("status", ["launched", "judged"]).not("ad_id", "is", null);
  if (!plans?.length) { out.skipped = "no launched tests"; return out; }
  const adIds = plans.map((p: any) => p.ad_id);
  const { data: perfAll } = await sb.from("ad_perf_window").select("*").in("ad_id", adIds);
  const perfOf = (adId: string) => (perfAll || []).find((r: any) => r.ad_id === adId && r.window_days === 7) || (perfAll || []).find((r: any) => r.ad_id === adId);

  const byAngle = new Map<string, Agg>(), byCamp = new Map<string, Agg>(), total = newAgg();
  const angleText = new Map<string, { caption: string | null; headline: string | null }>();
  const rowsOut: any[] = [];
  let maxDays = 0;
  for (const p of plans) {
    const perf = perfOf(p.ad_id);
    if (!perf) continue;
    const days = Math.floor((Date.now() - new Date(p.launched_at).getTime()) / DAY);
    maxDays = Math.max(maxDays, days);
    const ak = String(p.caption_index ?? "?");
    if (!byAngle.has(ak)) byAngle.set(ak, newAgg());
    if (!byCamp.has(p.campaign_id)) byCamp.set(p.campaign_id, newAgg());
    addAgg(byAngle.get(ak)!, perf); addAgg(byCamp.get(p.campaign_id)!, perf); addAgg(total, perf);
    if (!angleText.has(ak)) angleText.set(ak, { caption: clip(p.caption, 350), headline: clip(p.headline, 80) });
    const f = fin(addAggOne(perf));
    rowsOut.push({ plan_id: p.id, angle: ak, campaign_id: p.campaign_id, days, verdict: p.verdict, ...f });
  }
  const totalF = fin(total);
  const baseline = await baselineFor(key);
  const angles = [...byAngle.entries()].map(([k, a]) => ({ angle: k, ...fin(a), ...(angleText.get(k) || {}) })).sort((a, b) => a.angle.localeCompare(b.angle));
  const videos = [...byCamp.entries()].map(([c, a]) => ({ campaign_id: c, ...fin(a) }));
  const stats = { total: totalF, baseline, angles, videos, ads: rowsOut, max_days_running: maxDays };
  out.stats = { total: totalF, angles: angles.map((a) => ({ angle: a.angle, spend: a.spend_thb, msgs: a.messages, cpm: a.cost_per_message_thb })) };

  let summary_lo = `ຂໍ້ມູນຍັງໜ້ອຍ — ໃຊ້ເງິນລວມ ${totalF.spend_thb} ບາດ, ໄດ້ຂໍ້ຄວາມ ${totalF.messages}. ຍັງບໍ່ສະຫຼຸບບົດຮຽນ.`;
  let lessons: any[] = [];
  let note = "stats only";
  if (totalF.spend_thb >= MIN_SPEND_FOR_AI && ANTHROPIC_API_KEY) {
    const system = [
      "You are the ANALYSIS TEAM of a small Lao online shop's AI ad team. Input: real numbers of A/B ad tests (angle = caption style 0/1/2; same video in each campaign).",
      "Your job: find what the numbers really show and turn it into SHORT lessons for the shoot / edit / caption teams.",
      "Rules: (1) Use ONLY the numbers given. Never invent numbers. (2) If a gap is small or spend/messages are low, say it is too early; do not call a winner. (3) Compare against baseline cost_per_message when given. (4) Do not make health or medical claims, no guarantees.",
      "(5) Write ALL Lao text in very simple, short, correct Lao (Lao script only, NEVER Thai script, no English words except numbers and units like CTR). Each lesson max 2 short sentences. next_action_lo = one concrete thing the next shoot/edit/caption should do or test.",
      "Call the tool save_lessons exactly once. Give 1 to 5 lessons. scope is one of angle, hook, video, audience, general. evidence_angle is the angle number string the lesson is mostly about, or null.",
    ].join("\n");
    const tool = {
      name: "save_lessons", description: "Save the analysis summary and lessons",
      input_schema: {
        type: "object", required: ["summary_lo", "lessons"], properties: {
          summary_lo: { type: "string", description: "2-3 short Lao sentences: what happened overall" },
          lessons: { type: "array", maxItems: 5, items: { type: "object", required: ["scope", "lesson_lo", "next_action_lo"], properties: {
            scope: { type: "string", enum: ["angle", "hook", "video", "audience", "general"] },
            lesson_lo: { type: "string" }, next_action_lo: { type: "string" }, evidence_angle: { type: ["string", "null"] },
          } } },
        },
      },
    };
    const payload = { product: label, note: "numbers are THB; window 7 days", ...stats, ads: undefined };
    const base: any = { model: MODEL, max_tokens: 6000, system, tools: [tool], messages: [{ role: "user", content: "Analyse this and call save_lessons.\n" + JSON.stringify(payload) }] };
    const send = (b: any) => fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(b) });
    let res = await send({ ...base, thinking: { type: "disabled" } });
    let j = await res.json();
    if (!res.ok && /thinking/i.test(JSON.stringify(j))) { res = await send(base); j = await res.json(); }
    if (!res.ok) throw new Error("Anthropic " + res.status + ": " + JSON.stringify(j).slice(0, 300));
    const tu = (j.content || []).find((c: any) => c.type === "tool_use" && c.name === "save_lessons");
    if (!tu) throw new Error("no tool_use in answer");
    const bad = (s: any) => !s || THAI_SCRIPT.test(s) || GARBLE.test(s) || RISKY.test(s);
    if (!bad(tu.input.summary_lo)) summary_lo = tu.input.summary_lo;
    for (const l of (tu.input.lessons || []).slice(0, 5)) {
      if (bad(l.lesson_lo) || bad(l.next_action_lo)) continue;
      const ev = l.evidence_angle != null ? angles.find((a) => a.angle === String(l.evidence_angle)) : null;
      lessons.push({ scope: l.scope, lesson_lo: clip(l.lesson_lo, 500), next_action_lo: clip(l.next_action_lo, 400),
        evidence: ev ? { angle: ev.angle, spend_thb: ev.spend_thb, messages: ev.messages, cost_per_message_thb: ev.cost_per_message_thb, link_ctr_pct: ev.link_ctr_pct, baseline } : { total: totalF, baseline },
        confidence: confidenceOf(ev || totalF) });
    }
    note = `ai ok, ${lessons.length} lessons kept`;
  }
  out.summary_lo = summary_lo; out.lessons = lessons.length; out.note = note;
  if (dry) { out.dry_lessons = lessons; return out; }
  const { data: run, error: e1 } = await sb.from("ad_analyst_runs").insert({ product_key: key, summary_lo, stats, model: MODEL, note }).select("id").single();
  if (e1) throw new Error("save run: " + e1.message);
  if (lessons.length) {
    await sb.from("ad_lessons").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("product_key", key).eq("status", "draft");
    const { error: e2 } = await sb.from("ad_lessons").insert(lessons.map((l) => ({ ...l, product_key: key, run_id: run.id })));
    if (e2) throw new Error("save lessons: " + e2.message);
  }
  return out;
}
function addAggOne(p: any) { const a = newAgg(); addAgg(a, p); return a; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const results: any[] = [], warnings: string[] = [];
  try {
    const body = await req.json().catch(() => ({}));
    const dry = !!body.dry_run, force = !!body.force;
    let q = sb.from("ad_test_products").select("product_key,label").eq("enabled", true);
    if (body.product_key) q = q.eq("product_key", String(body.product_key));
    const { data: prods } = await q;
    if (!dry) {
      try { await fetch(`${SUPABASE_URL}/functions/v1/sync-ad-creative-insights`, { method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(60000) }); } catch (e) { warnings.push("sync insights: " + errMsg(e)); }
    }
    for (const p of prods || []) {
      try { results.push(await analyseProduct(p.product_key, p.label || p.product_key, dry, force)); }
      catch (e) { results.push({ product_key: p.product_key, error: errMsg(e) }); }
    }
    return new Response(JSON.stringify({ ok: true, dry, results, warnings }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: errMsg(e), results, warnings }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
