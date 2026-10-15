const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store" },
});

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isValidHash(h) {
  return typeof h === 'string' && h.length === 44 && /^[A-Za-z0-9+/=]+$/.test(h);
}

function isValidEncrypted(e) {
  return typeof e === 'string' && e.length > 100 && e.length < 10 * 1024 * 1024 && /^[A-Za-z0-9+/=]+$/.test(e);
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 11 * 1024 * 1024) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function handleVault({ request, supabase }) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    if (action === "register" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !isValidHash(body.passwordHash) || !isValidEncrypted(body.encryptedData)) {
        return json({ error: "invalid_input" }, 400);
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await supabase.from("vaults").insert({
        id,
        password_hash: body.passwordHash,
        encrypted_data: body.encryptedData,
        created_at: now,
        updated_at: now,
      });
      if (error) return json({ error: "database_request_failed" }, 503);
      return json({ id });

    } else if (action === "login" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !isValidHash(body.passwordHash)) {
        return json({ error: "invalid_input" }, 400);
      }
      const { data, error } = await supabase.from("vaults")
        .select("id,encrypted_data")
        .eq("password_hash", body.passwordHash)
        .maybeSingle();
      if (error) return json({ error: "database_request_failed" }, 503);
      if (!data) return json({ error: "not_found" }, 404);
      return json({ id: data.id, encryptedData: data.encrypted_data });

    } else if (action === "save" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !uuidRe.test(body.id) || !isValidEncrypted(body.encryptedData)) {
        return json({ error: "invalid_input" }, 400);
      }
      const { data, error } = await supabase.from("vaults")
        .update({ encrypted_data: body.encryptedData, updated_at: new Date().toISOString() })
        .eq("id", body.id)
        .select("id")
        .maybeSingle();
      if (error) return json({ error: "database_request_failed" }, 503);
      if (!data) return json({ error: "not_found" }, 404);
      return json({ ok: true });

    } else if (action === "load" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id || !uuidRe.test(id)) return json({ error: "invalid_input" }, 400);
      const { data, error } = await supabase.from("vaults")
        .select("id,encrypted_data")
        .eq("id", id)
        .maybeSingle();
      if (error) return json({ error: "database_request_failed" }, 503);
      if (!data) return json({ error: "not_found" }, 404);
      return json({ id: data.id, encryptedData: data.encrypted_data });

    } else {
      return json({ error: "not_found" }, 404);
    }
  } catch {
    return json({ error: "database_request_failed" }, 503);
  }
}
