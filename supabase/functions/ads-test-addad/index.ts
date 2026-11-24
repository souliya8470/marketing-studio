// ads-test-addad (v1) — adds ONE more ad (new creative + ad) to an EXISTING ad set. Used by ads-test-auto (v10) for A/B groups:
// 1 campaign (CBO) -> 1 ad set -> N ads. The first ad of the group is created by launch-ad (campaign + ad set + ad); the others come here.
// Nothing else is created or changed (no campaign, no ad set, no budget). Staff session token or service role only (same guard as launch-ad).

// ===== MS GUARD =====
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
const __origServe = Deno.serve.bind(Deno);
(Deno as any).serve = (...args: any[]) => {
  const i = args.length - 1; const h = args[i];
  args[i] = async (req: Request, ...rest: any[]) => {
    if (req.method === "OPTIONS") return h(req, ...rest);
    if (!(await __msAllowed(req))) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    return h(req, ...rest);
  };
  return (__origServe as any)(...args);
};
// ===== END MS GUARD =====

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FB_API_VERSION = "v21.0";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function fbPost(path: string, params: Record<string, any>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  body.set("access_token", META_ACCESS_TOKEN);
  const res = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${path}`, { method: "POST", body });
  const j = await res.json();
  if (j.error) {
    const detail = [j.error.error_user_title, j.error.error_user_msg, j.error.error_subcode ? `subcode ${j.error.error_subcode}` : null].filter(Boolean).join(" — ");
    throw new Error(`[${path.split("/").pop()}] ${j.error.message || JSON.stringify(j.error)}${detail ? " (" + detail + ")" : ""}`);
  }
  return j;
}
async function uploadImageB64(acct: string, b64: string): Promise<string> {
  const body = new URLSearchParams();
  body.set("bytes", b64.includes(",") ? b64.split(",")[1] : b64);
  body.set("access_token", META_ACCESS_TOKEN);
  const res = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${acct}/adimages`, { method: "POST", body });
  const j = await res.json();
  if (j.error) throw new Error(`[adimages] ${j.error.message || JSON.stringify(j.error)}`);
  const first = Object.keys(j.images || {})[0];
  if (!first || !j.images[first]?.hash) throw new Error("Failed to upload image to Facebook (no hash returned)");
  return j.images[first].hash;
}
async function thumbHashFromUrl(acct: string, url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[thumbnail] Failed to fetch video thumbnail (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return uploadImageB64(acct, btoa(s));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  let b: any = {};
  const logId = "add" + Date.now() + Math.random().toString(36).slice(2, 7);
  try {
    b = await req.json();
    if (!META_ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN secret is not set");
    const { adAccountId, adsetId, campaignId, campaignName, adName, logName, pageId, destinationType, pageWelcomeMessage, primaryText, headline,
      videoId, videoThumbnailImageHash, videoThumbnailUrl, imageBase64, existingImageHash, ctaType, instagramUserId, degreesOfFreedomSpec, active, launchedBy, dailyBudget } = b;
    if (!adAccountId || !adsetId || !campaignId) throw new Error("Missing ad account / ad set / campaign");
    if (!pageId) throw new Error("Missing Facebook Page");
    if (!primaryText) throw new Error("Missing ad text (Primary text)");
    if (!logName) throw new Error("Missing logName");
    const acct = String(adAccountId).startsWith("act_") ? String(adAccountId) : `act_${adAccountId}`;
    const status = active ? "ACTIVE" : "PAUSED";
    const name = adName || `${logName} - Ad`;
    const wa = destinationType === "whatsapp";
    const dest = wa ? { app_destination: "WHATSAPP" } : { app_destination: "MESSENGER" };

    let creativeParams: Record<string, any>;
    if (videoId) {
      if (!videoThumbnailImageHash && !videoThumbnailUrl) throw new Error("Missing video thumbnail — the video may still be processing");
      const hash = videoThumbnailUrl ? await thumbHashFromUrl(acct, videoThumbnailUrl) : videoThumbnailImageHash;
      const vd: Record<string, any> = { video_id: videoId, image_hash: hash, message: primaryText, call_to_action: { type: ctaType || "MESSAGE_PAGE", value: dest } };
      if (headline) vd.title = headline;
      if (pageWelcomeMessage && !wa) vd.page_welcome_message = pageWelcomeMessage;
      creativeParams = { name: `${logName} - creative (new video)`, object_story_spec: { page_id: pageId, video_data: vd } };
    } else {
      const hash = imageBase64 ? await uploadImageB64(acct, imageBase64) : (existingImageHash || null);
      if (!hash) throw new Error("Missing ad image or video");
      const ld: Record<string, any> = { message: primaryText, image_hash: hash, call_to_action: { type: ctaType || "MESSAGE_PAGE", value: dest } };
      if (headline) ld.name = headline;
      if (pageWelcomeMessage && !wa) ld.page_welcome_message = pageWelcomeMessage;
      creativeParams = { name: `${logName} - creative`, object_story_spec: { page_id: pageId, link_data: ld } };
    }
    if (instagramUserId) creativeParams.instagram_user_id = String(instagramUserId);
    if (degreesOfFreedomSpec && typeof degreesOfFreedomSpec === "object") creativeParams.degrees_of_freedom_spec = degreesOfFreedomSpec;
    const creative = await fbPost(`${acct}/adcreatives`, creativeParams);
    const ad = await fbPost(`${acct}/ads`, { name, adset_id: adsetId, creative: { creative_id: creative.id }, status });

    const nowIso = new Date().toISOString();
    await sb.from("ads").upsert({ id: ad.id, ad_set_id: adsetId, name, status, effective_status: status, updated_at: nowIso });
    await sb.from("ad_launch_log").insert({
      id: logId, launched_by: launchedBy || "", ad_account_id: adAccountId, objective: "messages", flow_type: "existing_adset",
      campaign_id: campaignId, campaign_name: campaignName || null, adset_id: adsetId, adset_name: logName,
      ad_id: ad.id, ad_name: name, daily_budget: dailyBudget || null, page_id: pageId, destination_type: wa ? "whatsapp" : "messenger", success: true,
    });
    return json({ ok: true, campaignId, adsetId, adId: ad.id });
  } catch (e) {
    const msg = String((e as any)?.message || e);
    try {
      await sb.from("ad_launch_log").insert({ id: logId, launched_by: b?.launchedBy || "", ad_account_id: b?.adAccountId || null, objective: "messages", flow_type: "existing_adset", campaign_name: b?.campaignName || null, adset_name: b?.logName || null, daily_budget: b?.dailyBudget || null, success: false, error_message: msg });
    } catch (_e) { /* best-effort */ }
    return json({ ok: false, error: msg }, 400);
  }
});
