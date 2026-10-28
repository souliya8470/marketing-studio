// online-slip-verify (v1): check the transfer slip of an ONLINE order (online_orders) against BCEL's OneProof service.
// POST { order_id } -> verdict saved in online_orders.slip_check and returned.
// verdict: "pass" (BCEL confirmed, amount+receiver+time ok, not a duplicate) | "fail" (suspicious: reasons[]) | "unknown" (cannot auto-check: no QR / not BCEL / BCEL unreachable -> staff checks by eye)
// READ-ONLY toward BCEL (same unofficial OneProof endpoint as cf-slip-qr). Never changes order status; staff still confirm.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import jpeg from "npm:jpeg-js@0.4.4";
import jsQR from "npm:jsqr@1.4.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const PREFIX = `${SUPABASE_URL}/storage/v1/object/public/online-payment-slips/`;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function tlv(s: string): Record<string, string> {
  const out: Record<string, string> = {}; let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2); const len = parseInt(s.slice(i + 2, i + 4), 10);
    if (!Number.isFinite(len)) break;
    out[tag] = s.slice(i + 4, i + 4 + len); i += 4 + len;
  }
  return out;
}
async function decodeQr(image_url: string): Promise<string | null> {
  const r = await fetch(image_url);
  if (!r.ok) throw new Error("image fetch failed " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  let img: { data: Uint8Array; width: number; height: number };
  try { img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 }) as any; } catch { return null; }
  const data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const found = jsQR(data, img.width, img.height, { inversionAttempts: "attemptBoth" });
  return found ? found.data : null;
}
const latinWords = (s: string) => (String(s || "").match(/[A-Za-z]{4,}/g) || []).map((w) => w.toLowerCase());

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const orderId = String(body.order_id || "");
    if (!orderId) return reply({ ok: false, error: "order_id required" }, 400);
    const { data: o, error: oe } = await sb.from("online_orders").select("id, order_no, total_kip, payment_slip_url, created_at, payment_bank_name").eq("id", orderId).maybeSingle();
    if (oe || !o) return reply({ ok: false, error: "order not found" }, 404);

    const res: Record<string, unknown> = { checked_at: new Date().toISOString(), verdict: "unknown", reasons: [] as string[] };
    const reasons = res.reasons as string[];
    const save = async () => { await sb.from("online_orders").update({ slip_check: res }).eq("id", orderId); return reply({ ok: true, slip_check: res }); };

    const url = String(o.payment_slip_url || "");
    if (!url) { reasons.push("ບໍ່ມີຮູບສະລິບ"); res.verdict = "fail"; return await save(); }
    if (!url.startsWith(PREFIX)) { reasons.push("ກວດອັດຕະໂນມັດບໍ່ໄດ້ (ລິ້ງຮູບບໍ່ແມ່ນຂອງລະບົບ) — ກວດດ້ວຍຕາ"); return await save(); }

    let qr: string | null = null;
    try { qr = await decodeQr(url); } catch (e) { reasons.push("ໂຫຼດຮູບສະລິບບໍ່ໄດ້ — ກວດດ້ວຍຕາ"); return await save(); }
    if (!qr) { reasons.push("ບໍ່ພົບ QR ໃນສະລິບ (ບໍ່ແມ່ນສະລິບ BCEL OnePay ຫຼື ຮູບບໍ່ຊັດ) — ກວດດ້ວຍຕາ"); return await save(); }
    const top = tlv(qr); const m33 = top["33"] ? tlv(top["33"]) : {};
    const ticket = (m33["03"] || "").replace(/\s+/g, ""); const fccref = (m33["04"] || "").replace(/\s+/g, "");
    if (m33["01"] !== "ONEPROOF" || !ticket || !fccref) { reasons.push("QR ບໍ່ແມ່ນ OneProof ຂອງ BCEL — ກວດດ້ວຍຕາ"); return await save(); }

    let rec: any = null; let unreachable = false;
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(`https://bcel.la:8083/onesure.php?fccref=${encodeURIComponent(fccref)}&ticket=${encodeURIComponent(ticket)}`, { headers: { "User-Agent": "Dart/2.10 (dart:io)" }, signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) rec = await r.json().catch(() => null); else unreachable = true;
    } catch { unreachable = true; }
    if (unreachable || !rec) { reasons.push("ຕິດຕໍ່ BCEL ບໍ່ໄດ້ຕອນນີ້ — ກວດດ້ວຍຕາ ຫຼື ກົດກວດໃໝ່"); return await save(); }
    if (Number(rec.result) !== 0 || rec.amount == null) {
      res.verdict = "fail"; reasons.push("🚨 BCEL ບໍ່ພົບການໂອນນີ້ — ສົງໄສສະລິບປອມ"); return await save();
    }
    if (String(rec.ticket || "").replace(/\s+/g, "") !== ticket) {
      res.verdict = "fail"; reasons.push("🚨 ຂໍ້ມູນ BCEL ບໍ່ກົງກັບສະລິບ — ສົງໄສສະລິບປອມ"); return await save();
    }

    const txIso = rec.txtime ? String(rec.txtime).trim().replace(" ", "T") + "+07:00" : null;
    const amount = Number(rec.amount); const ccy = String(rec.ccy || "");
    res.bcel = { txtime_iso: txIso, amount, ccy, source_name: String(rec.sourcename || "").trim(), source_account: String(rec.sourceaccount || "").trim(),
      destination_name: String(rec.destinationname || "").trim(), destination_account: String(rec.destinationaccount || "").trim(), ticket };
    res.ticket = ticket;
    let bad = false; let warn = false;

    // amount
    const total = Number(o.total_kip || 0);
    if (ccy && ccy.toUpperCase() !== "LAK") { warn = true; reasons.push(`⚠️ ສະກຸນເງິນໃນສະລິບແມ່ນ ${ccy} ບໍ່ແມ່ນກີບ — ກວດດ້ວຍຕາ`); }
    else if (Math.round(amount) !== Math.round(total)) { bad = true; reasons.push(`🚨 ຍອດໂອນ ${Math.round(amount).toLocaleString("en-US")} ບໍ່ກົງກັບຍອດອໍເດີ ${Math.round(total).toLocaleString("en-US")} ກີບ`); }
    // receiver
    const { data: banks } = await sb.from("payment_banks").select("bank_name, account_name").eq("is_active", true);
    const wanted = new Set<string>();
    for (const b of banks || []) if (/bcel/i.test(String(b.bank_name))) latinWords(String(b.account_name)).forEach((w) => wanted.add(w));
    const destWords = new Set(latinWords(String(rec.destinationname || "")));
    if (wanted.size && ![...wanted].some((w) => destWords.has(w))) { bad = true; reasons.push("🚨 ໂອນເຂົ້າບັນຊີທີ່ບໍ່ແມ່ນຂອງຮ້ານ"); }
    // time: transfer must be at/after order creation (5 min tolerance) and not absurdly old
    if (txIso) {
      const t = new Date(txIso).getTime(); const c = new Date(String(o.created_at)).getTime();
      if (t < c - 5 * 60 * 1000) { bad = true; reasons.push("🚨 ເວລາໂອນກ່ອນເວລາສ້າງອໍເດີ — ອາດເປັນສະລິບເກົ່າທີ່ເອົາມາໃຊ້ຊ້ຳ"); }
    }
    // duplicate (another online order or a Live CF order already used this ticket)
    const { data: dups } = await sb.from("online_orders").select("order_no").neq("id", orderId).neq("status", "cancelled").contains("slip_check", { ticket }).limit(1);
    const { data: dupCf } = await sb.from("live_cf_orders").select("order_no").eq("slip_ref", ticket).neq("status", "cancelled").limit(1);
    const dup = (dups && dups[0]?.order_no) || (dupCf && dupCf[0]?.order_no) || null;
    if (dup) { bad = true; res.duplicate_of = dup; reasons.push(`🚨 ສະລິບນີ້ຖືກໃຊ້ແລ້ວກັບອໍເດີ ${dup}`); }

    if (bad) res.verdict = "fail";
    else if (warn) res.verdict = "unknown";
    else { res.verdict = "pass"; reasons.push("BCEL ຢືນຢັນ: ຍອດກົງ, ບັນຊີຮ້ານ, ເວລາຖືກ, ບໍ່ຊ້ຳ"); }
    return await save();
  } catch (e) {
    return reply({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
