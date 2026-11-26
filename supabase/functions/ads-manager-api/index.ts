// ads-manager-api (v2, 2026-11-26) — backs the "📑 Ads Manager" sub-page of Marketing Studio.
//   v2: detail also returns the REAL page (name + avatar) the ad / ad set / campaign runs with, a large picture for the preview, and
//       action "preview" returns Facebook's own preview iframe (GET /{ad_id}/previews) like the real Ads Manager.
//   action "detail": live read of one campaign / ad set / ad from the Facebook Marketing API (all settings, targeting, placements, creative, greeting message).
//   action "edit":   whitelisted edits (campaign/adset/ad name, end time, ad-set age/gender/countries/placements, ad primary text/headline/CTA).
//                    Status, budget, start time and bid strategy keep using update-ad-entity.
// Guarded exactly like update-ad-entity: only staff session tokens (?t= or Bearer) or the service role. Token per ad account (system or personal).
// NOT yet tested against live Facebook when written (sandbox cannot reach Facebook) — errors from Facebook are returned verbatim.

const __MS_URL = Deno.env.get("SUPABASE_URL")!;
const __MS_SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function __msAllowed(req: Request): Promise<boolean> {
  try {
    let t = new URL(req.url).searchParams.get("t") || "";
    if (!t) t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!t) return false;
    if (t === __MS_SRK) return true;
    const r = await fetch(__MS_URL + "/rest/v1/rpc/ms_token_ok", { method: "POST", headers: { apikey: __MS_SRK, Authorization: "Bearer " + __MS_SRK, "Content-Type": "application/json" }, body: JSON.stringify({ p_token: t }) });
    return (await r.json()) === true;
  } catch (_e) { return false; }
}
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FB = "https://graph.facebook.com/v21.0";
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const sb = createClient(__MS_URL, __MS_SRK);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const TABLE: Record<string, string> = { campaign: "ad_campaigns", adset: "ad_sets", ad: "ads" };

async function personalToken(): Promise<string | null> {
  const { data } = await sb.from("fb_user_tokens").select("long_lived_token,token_expires_at,updated_at").order("updated_at", { ascending: false });
  const row = (data || []).find((r: any) => r.long_lived_token && (!r.token_expires_at || new Date(r.token_expires_at) > new Date()));
  return row ? row.long_lived_token : null;
}
async function tokenFor(type: string, id: string): Promise<string> {
  let campaignId: string | null = null;
  try {
    if (type === "campaign") campaignId = id;
    else if (type === "adset") campaignId = (await sb.from("ad_sets").select("campaign_id").eq("id", id).maybeSingle()).data?.campaign_id || null;
    else {
      const ad = (await sb.from("ads").select("ad_set_id").eq("id", id).maybeSingle()).data;
      if (ad?.ad_set_id) campaignId = (await sb.from("ad_sets").select("campaign_id").eq("id", ad.ad_set_id).maybeSingle()).data?.campaign_id || null;
    }
    if (campaignId) {
      const camp = (await sb.from("ad_campaigns").select("ad_account_id").eq("id", campaignId).maybeSingle()).data;
      if (camp?.ad_account_id) {
        const acc = (await sb.from("ad_accounts").select("token_source").eq("id", camp.ad_account_id).maybeSingle()).data;
        if (acc?.token_source === "personal") {
          const t = await personalToken();
          if (!t) throw new Error("token Facebook ສ່ວນຕົວບໍ່ມີ ຫຼື ໝົດອາຍຸແລ້ວ — ກົດ 'ເຊື່ອມ Facebook' ໃນໜ້າຈັດການບັນຊີ");
          return t;
        }
      }
    }
  } catch (e) { if (String((e as any)?.message || "").includes("token Facebook")) throw e; }
  return META_ACCESS_TOKEN;
}
function fbErr(j: any): string {
  const e = j.error;
  const d = [e.error_user_title, e.error_user_msg, e.error_subcode ? `subcode ${e.error_subcode}` : null].filter(Boolean).join(" — ");
  return `Facebook API error: ${e.message || JSON.stringify(e)}${d ? " (" + d + ")" : ""}`;
}
async function fbGet(path: string, token: string, fields: string) {
  const r = await fetch(`${FB}/${path}?fields=${encodeURIComponent(fields)}&access_token=${token}`);
  const j = await r.json(); if (j.error) throw new Error(fbErr(j)); return j;
}
async function fbGetX(path: string, token: string, fields: string, extra: Record<string, string>) {
  const q = new URLSearchParams({ fields, access_token: token, ...extra });
  const r = await fetch(`${FB}/${path}?${q.toString()}`);
  const j = await r.json(); if (j.error) throw new Error(fbErr(j)); return j;
}
async function fbPost(path: string, token: string, params: Record<string, any>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  body.set("access_token", token);
  const r = await fetch(`${FB}/${path}`, { method: "POST", body });
  const j = await r.json(); if (j.error) throw new Error(fbErr(j)); return j;
}

const F_CAMPAIGN = "name,objective,status,effective_status,buying_type,bid_strategy,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,created_time,updated_time,special_ad_categories,spend_cap,issues_info";
const F_ADSET = "name,status,effective_status,campaign_id,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,billing_event,bid_strategy,bid_amount,destination_type,promoted_object,targeting,attribution_spec,learning_stage_info,is_dynamic_creative,pacing_type,frequency_control_specs,issues_info,created_time";
const F_AD = "name,status,effective_status,adset_id,campaign_id,account_id,created_time,tracking_specs,issues_info,preview_shareable_link,creative{id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,call_to_action_type,title,body,degrees_of_freedom_spec,url_tags}";

function welcomeOf(creative: any) {
  const spec = creative?.object_story_spec; if (!spec) return null;
  for (const k of ["link_data", "video_data", "photo_data", "template_data"]) {
    const w = spec[k]?.page_welcome_message;
    if (w) {
      const raw = typeof w === "string" ? w : JSON.stringify(w);
      const strings: string[] = []; let templateId: string | null = null;
      const walk = (v: any, key = "") => {
        if (v == null) return;
        if (typeof v === "string") { if (/template_id/i.test(key)) templateId = v; else if (v.length > 1 && !/^(VISUAL|TEXT|text|welcome_message|autofill_message|\d+)$/.test(v) && !strings.includes(v)) strings.push(v); }
        else if (typeof v === "number") { if (/template_id/i.test(key)) templateId = String(v); }
        else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
      };
      try { walk(JSON.parse(raw)); } catch (_e) { /* raw only */ }
      return { template_id: templateId, texts: strings.slice(0, 14) };
    }
  }
  return null;
}
// pulls the editable creative fields out of object_story_spec
function creativeParts(creative: any) {
  const spec = creative?.object_story_spec || {};
  const key = ["video_data", "link_data", "photo_data"].find((k) => spec[k]);
  const d = key ? spec[key] : {};
  return { kind: key || null, page_id: spec.page_id || null, primary_text: d.message ?? creative?.body ?? "", headline: d.title ?? d.name ?? creative?.title ?? "", cta: d.call_to_action?.type || creative?.call_to_action_type || null, video_id: d.video_id || creative?.video_id || null, image_url: d.image_url || creative?.image_url || null, link: d.call_to_action?.value?.link || d.link || null };
}

async function logChange(type: string, id: string, name: string, action: string, oldV: string, newV: string, by: string) {
  try { await sb.from("ad_control_log").insert({ entity_type: type, entity_id: id, entity_name: name || "", action, old_value: oldV, new_value: newV, changed_by: by || "" }); } catch (_e) { /* best effort */ }
}

// real page behind an id: name + avatar (never throws — a page we cannot read just comes back with only its id)
async function pageInfo(pageId: string | null | undefined, token: string) {
  if (!pageId) return null;
  try {
    const j = await fbGetX(String(pageId), token, "name,link,picture.type(large){url}", {});
    return { id: String(pageId), name: j.name || null, link: j.link || null, avatar: j.picture?.data?.url || null };
  } catch (e) { return { id: String(pageId), name: null, link: null, avatar: null, error: String((e as any)?.message || e).slice(0, 300) }; }
}
// the biggest picture we can find for an ad (video poster / image), so the preview is not a 64px thumbnail
async function bigPicture(creative: any, parts: any, token: string): Promise<string | null> {
  try {
    const vid = parts?.video_id || creative?.video_id;
    if (vid) {
      const v = await fbGet(String(vid), token, "picture,thumbnails{uri,width,height,is_preferred}");
      const th = (v.thumbnails?.data || []).slice().sort((a: any, b: any) => (b.is_preferred ? 1 : 0) - (a.is_preferred ? 1 : 0) || (b.width || 0) - (a.width || 0));
      const pref = th.find((t: any) => t.is_preferred) || th[0];
      if (pref?.uri) return pref.uri;
      if (v.picture) return v.picture;
    }
    if (creative?.id) {
      const c = await fbGetX(String(creative.id), token, "image_url,thumbnail_url", { thumbnail_width: "1080", thumbnail_height: "1080" });
      return c.image_url || c.thumbnail_url || null;
    }
  } catch (_e) { /* fall through */ }
  return parts?.image_url || creative?.image_url || creative?.thumbnail_url || null;
}
async function doDetail(type: string, id: string, token: string) {
  const fields = type === "campaign" ? F_CAMPAIGN : type === "adset" ? F_ADSET : F_AD;
  const raw = await fbGet(id, token, fields);
  const out: any = { raw };
  if (type === "ad") {
    out.parts = creativeParts(raw.creative); out.welcome = welcomeOf(raw.creative);
    const [page, pic] = await Promise.all([pageInfo(out.parts.page_id, token), bigPicture(raw.creative, out.parts, token)]);
    out.page = page; out.bigPicture = pic;
  } else if (type === "adset") {
    out.page = await pageInfo(raw.promoted_object?.page_id, token);
  } else {
    // campaign: the pages of its ad sets
    try {
      const sets = await fbGetX(id + "/adsets", token, "promoted_object", { limit: "100" });
      const ids = [...new Set(((sets.data || []) as any[]).map((a) => a.promoted_object?.page_id).filter(Boolean))].slice(0, 5);
      out.pages = (await Promise.all(ids.map((x) => pageInfo(x as string, token)))).filter(Boolean);
    } catch (_e) { out.pages = []; }
  }
  return out;
}
const PREVIEW_FORMATS = ["MOBILE_FEED_STANDARD", "DESKTOP_FEED_STANDARD", "FACEBOOK_REELS_MOBILE", "FACEBOOK_STORY_MOBILE", "INSTAGRAM_STANDARD", "MESSENGER_MOBILE_INBOX_MEDIA"];
async function doPreview(id: string, token: string, format: string) {
  const f = PREVIEW_FORMATS.includes(format) ? format : "MOBILE_FEED_STANDARD";
  const j = await fbGetX(id + "/previews", token, "body", { ad_format: f });
  const body: string = j.data?.[0]?.body || "";
  const m = body.match(/src="([^"]+)"/);
  const src = m ? m[1].replace(/&amp;/g, "&") : null;
  return { format: f, src, width: Number((body.match(/width="(\d+)"/) || [])[1]) || null, height: Number((body.match(/height="(\d+)"/) || [])[1]) || null };
}

async function doEdit(type: string, id: string, token: string, ch: any, by: string, entName: string) {
  const done: string[] = [];
  const upd: Record<string, any> = {};
  // names (all levels)
  if (typeof ch.name === "string" && ch.name.trim()) {
    const name = ch.name.trim().slice(0, 400);
    await fbPost(id, token, { name });
    const col = type === "campaign" ? "campaign_name" : "name";
    upd[col] = name; done.push("name"); await logChange(type, id, entName, "edit_name", entName, name, by);
  }
  // end time (campaign stop_time / ad set end_time); "" = no end date
  if (ch.end_time !== undefined && type !== "ad") {
    const f = type === "campaign" ? "stop_time" : "end_time";
    if (ch.end_time === "" || ch.end_time === null) {
      if (type === "campaign") await fbPost(id, token, { stop_time: 0 }); else await fbPost(id, token, { end_time: 0 });
      await logChange(type, id, entName, "edit_end_time", "", "none", by);
    } else {
      const d = new Date(ch.end_time); if (isNaN(d.getTime())) throw new Error("Invalid end_time");
      await fbPost(id, token, { [f]: d.toISOString() });
      await logChange(type, id, entName, "edit_end_time", "", d.toISOString(), by);
    }
    done.push("end_time");
  }
  // ad set targeting patch: read-modify-write the whole targeting object
  if (type === "adset" && (ch.targeting || ch.publisher_platforms)) {
    const cur = (await fbGet(id, token, "targeting")).targeting || {};
    const t = JSON.parse(JSON.stringify(cur));
    const tp = ch.targeting || {};
    if (tp.age_min != null) { const n = Number(tp.age_min); if (!(n >= 13 && n <= 65)) throw new Error("age_min must be 13-65"); t.age_min = n; }
    if (tp.age_max != null) { const n = Number(tp.age_max); if (!(n >= 13 && n <= 65)) throw new Error("age_max must be 13-65"); t.age_max = n; }
    if (t.age_min != null && t.age_max != null && t.age_min > t.age_max) throw new Error("age_min is greater than age_max");
    if (Array.isArray(tp.genders)) { if (tp.genders.length) t.genders = tp.genders.map(Number).filter((x: number) => x === 1 || x === 2); else delete t.genders; }
    if (Array.isArray(tp.countries)) { if (!tp.countries.length) throw new Error("at least one country is required"); t.geo_locations = { ...(t.geo_locations || {}), countries: tp.countries.map((c: string) => String(c).toUpperCase()) }; }
    if (Array.isArray(tp.excluded_countries)) {
      const ex = { ...(t.excluded_geo_locations || {}) };
      if (tp.excluded_countries.length) ex.countries = tp.excluded_countries.map((c: string) => String(c).toUpperCase()); else delete ex.countries;
      if (Object.keys(ex).length) t.excluded_geo_locations = ex; else delete t.excluded_geo_locations;
    }
    if (Array.isArray(ch.publisher_platforms)) {
      const POS = ["facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "threads_positions"];
      for (const k of POS) delete t[k];
      const ok = ["facebook", "instagram", "messenger", "audience_network"];
      const pp = ch.publisher_platforms.filter((x: string) => ok.includes(x));
      if (pp.length) t.publisher_platforms = pp; else delete t.publisher_platforms; // empty = automatic (Advantage+ placements)
    }
    await fbPost(id, token, { targeting: t });
    done.push("targeting"); await logChange(type, id, entName, "edit_targeting", JSON.stringify({ age: [cur.age_min, cur.age_max], g: cur.genders, geo: cur.geo_locations?.countries, ex: cur.excluded_geo_locations?.countries, pp: cur.publisher_platforms }), JSON.stringify({ age: [t.age_min, t.age_max], g: t.genders, geo: t.geo_locations?.countries, ex: t.excluded_geo_locations?.countries, pp: t.publisher_platforms }), by);
  }
  // ad creative text: a creative cannot be edited, so build a new one from the old spec and swap it onto the ad
  if (type === "ad" && ch.creative) {
    const c = ch.creative;
    const ad = await fbGet(id, token, F_AD);
    const old = ad.creative; const spec = JSON.parse(JSON.stringify(old?.object_story_spec || {}));
    const key = ["video_data", "link_data"].find((k) => spec[k]);
    if (!key) throw new Error("This ad's creative is not a plain video/link ad — cannot edit its text here");
    const d = spec[key];
    if (typeof c.primary_text === "string") d.message = c.primary_text;
    if (typeof c.headline === "string") { if (key === "video_data") d.title = c.headline; else d.name = c.headline; }
    if (typeof c.cta === "string" && c.cta) d.call_to_action = { ...(d.call_to_action || {}), type: c.cta };
    const acct = "act_" + String(ad.account_id).replace(/^act_/, "");
    const params: Record<string, any> = { name: ((old?.name || "creative") + " (edit " + new Date().toISOString().slice(0, 10) + ")").slice(0, 200), object_story_spec: spec };
    if (old?.degrees_of_freedom_spec) params.degrees_of_freedom_spec = old.degrees_of_freedom_spec;
    const nc = await fbPost(`${acct}/adcreatives`, token, params);
    await fbPost(id, token, { creative: { creative_id: nc.id } });
    done.push("creative");
    const o = creativeParts(old);
    await logChange(type, id, entName, "edit_creative", JSON.stringify({ t: o.primary_text, h: o.headline, c: o.cta }).slice(0, 900), JSON.stringify({ t: c.primary_text, h: c.headline, c: c.cta }).slice(0, 900), by);
  }
  if (Object.keys(upd).length) await sb.from(TABLE[type]).update({ ...upd, updated_at: new Date().toISOString() }).eq("id", id);
  return done;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await __msAllowed(req))) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    if (!META_ACCESS_TOKEN) return json({ ok: false, error: "META_ACCESS_TOKEN secret is not set" }, 500);
    const b = await req.json();
    const { action, entityType, entityId } = b || {};
    if (!TABLE[entityType]) return json({ ok: false, error: "Invalid entityType" }, 400);
    if (!entityId) return json({ ok: false, error: "Missing entityId" }, 400);
    const token = await tokenFor(entityType, String(entityId));
    if (action === "detail") return json({ ok: true, entityType, ...(await doDetail(entityType, String(entityId), token)) });
    if (action === "preview") {
      if (entityType !== "ad") return json({ ok: false, error: "preview is for ads only" }, 400);
      return json({ ok: true, ...(await doPreview(String(entityId), token, String(b.format || ""))) });
    }
    if (action === "edit") {
      if (!b.changes || typeof b.changes !== "object") return json({ ok: false, error: "Missing changes" }, 400);
      const done = await doEdit(entityType, String(entityId), token, b.changes, b.changedBy || "", b.entityName || "");
      return json({ ok: true, done });
    }
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String((e as any)?.message || e) }, 400); }
});
