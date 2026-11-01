import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Per-campaign ON/OFF time schedules (Laos time, UTC+7). Called by pg_cron every 5 min.
// Reuses update-ad-entity (toggle_status) so tokens, local DB and ad_control_log stay consistent.
const WINDOW_MIN = 60; // catch up a missed slot for up to 60 minutes

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, key);
  const body = await req.json().catch(() => ({}));
  const nowMs = body.now_iso ? Date.parse(body.now_iso) : Date.now();
  const laos = new Date(nowMs + 7 * 3600 * 1000);
  const today = laos.toISOString().slice(0, 10);
  const dow = laos.getUTCDay();
  const nowMin = laos.getUTCHours() * 60 + laos.getUTCMinutes();
  const toMin = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

  const { data: rows, error } = await sb.from("campaign_schedules").select("*").eq("enabled", true);
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });

  const results: any[] = [];
  for (const s of rows || []) {
    const onMin = toMin(s.on_time), offMin = toMin(s.off_time);
    const days: number[] = s.days || [];
    const actions: Array<"ACTIVE" | "PAUSED"> = [];
    const patch: any = {};
    if (onMin !== null && days.includes(dow) && nowMin >= onMin && nowMin < onMin + WINDOW_MIN && s.last_on_date !== today) {
      actions.push("ACTIVE"); patch.last_on_date = today;
    }
    if (offMin !== null && s.last_off_date !== today) {
      const crosses = onMin !== null && offMin < onMin;
      const dayOk = days.includes(crosses ? (dow + 6) % 7 : dow);
      if (dayOk && nowMin >= offMin && nowMin < offMin + WINDOW_MIN) { actions.push("PAUSED"); patch.last_off_date = today; }
    }
    if (actions.length === 0) continue;
    const errs: string[] = [];
    for (const st of actions) {
      for (const c of s.campaigns || []) {
        try {
          const r = await fetch(`${url}/functions/v1/update-ad-entity`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
            body: JSON.stringify({ entityType: "campaign", entityId: c.id, action: "toggle_status", newStatus: st, entityName: c.name || c.id, changedBy: `schedule${s.name ? ": " + s.name : ""}` }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) errs.push(`${c.name || c.id}: ${j.error || r.status}`);
        } catch (e) { errs.push(`${c.name || c.id}: ${(e as Error).message}`); }
      }
    }
    patch.last_run_at = new Date().toISOString();
    patch.last_error = errs.length ? errs.join("\n").slice(0, 800) : null;
    await sb.from("campaign_schedules").update(patch).eq("id", s.id);
    results.push({ id: s.id, actions, errors: errs });
  }
  return new Response(JSON.stringify({ ok: true, today, nowMin, ran: results }), { headers: { "Content-Type": "application/json" } });
});
