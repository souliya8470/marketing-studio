// editor-video-intake — receives finished videos from the shop server (Sykhai Editor auto-export).
// Auth: header x-sk-key = secret whose sha256 is in public.editor_intake_keys (not revoked). No staff session / anon JWT is accepted here.
// Actions (POST JSON): products | init (-> signed upload URL) | done (-> insert row into edited_product_videos, upload thumbnail)
// Snapshot of the deployed version 1 (Supabase is the authoritative copy).
import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-sk-key, content-type, authorization, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const BUCKET = "product-assets";
async function sha256(s: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const safe = (n: string) => { const d = n.lastIndexOf("."); const base = (d > 0 ? n.slice(0, d) : n).replace(/[^A-Za-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "") || "video"; return base.slice(0, 60) + ".mp4"; };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ error: "POST only" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const key = req.headers.get("x-sk-key") || "";
  if (key.length < 20) return J({ error: "unauthorized" }, 401);
  const h = await sha256(key);
  const { data: ok } = await sb.from("editor_intake_keys").select("id").eq("secret_sha256", h).eq("revoked", false).maybeSingle();
  if (!ok) return J({ error: "unauthorized" }, 401);
  let b: any; try { b = await req.json(); } catch (_e) { return J({ error: "bad json" }, 400); }
  try {
    if (b.action === "products") {
      const { data, error } = await sb.from("products").select("id,name").order("name").limit(500);
      if (error) throw error; return J({ products: data || [] });
    }
    if (b.action === "init") {
      const pid = String(b.product_id || "").replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 60) || "none";
      const path = `edited/videos/${pid}/${Date.now()}_${safe(String(b.file_name || b.title || "video"))}`;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) throw error;
      return J({ path: data.path, signedUrl: data.signedUrl, token: data.token });
    }
    if (b.action === "done") {
      const path = String(b.path || ""); if (!path.startsWith("edited/videos/")) return J({ error: "bad path" }, 400);
      const pub = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      let thumb: string | null = null;
      const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(b.thumb || ""));
      if (m) {
        const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
        if (bin.length < 400000) {
          const tp = path.replace(/\.mp4$/, "") + "_thumb." + (m[1] === "png" ? "png" : "jpg");
          const up = await sb.storage.from(BUCKET).upload(tp, bin, { contentType: "image/" + m[1], upsert: true });
          if (!up.error) thumb = sb.storage.from(BUCKET).getPublicUrl(tp).data.publicUrl;
        }
      }
      const row = {
        product_id: b.product_id || null, product_name: b.product_name || null, title: String(b.title || b.file_name || "").slice(0, 200),
        file_name: String(b.file_name || "video.mp4").slice(0, 200), storage_path: path, public_url: pub, thumb_url: thumb,
        width: b.width || null, height: b.height || null, duration_sec: b.duration_sec || null, size_bytes: b.size_bytes || null,
        project_id: b.project_id ? String(b.project_id).slice(0, 80) : null, job_id: b.job_id ? String(b.job_id).slice(0, 80) : null,
        note: b.note ? String(b.note).slice(0, 500) : null, uploaded_by: String(b.uploaded_by || "Sykhai Editor").slice(0, 80),
      };
      const { data, error } = await sb.from("edited_product_videos").insert(row).select("id").single();
      if (error) throw error; return J({ id: data.id, public_url: pub });
    }
    return J({ error: "unknown action" }, 400);
  } catch (e) { return J({ error: String((e as any)?.message || e) }, 500); }
});
