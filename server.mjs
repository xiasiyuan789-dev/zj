// 基金金库 - 自托管 Node 服务端（零依赖）
// 托管 public/ 静态文件，并以与 functions/handler.mjs 相同的契约实现
// /functions/v1/app?action=register|login|save|load 四个接口。
//
// 存储模式（由环境变量决定）:
//   SUPABASE_URL + SUPABASE_ANON_KEY 均设置 → 云端模式: 数据存 Supabase 的 vaults 表（原版设计）
//   未设置 → 本地模式: 数据存 data/vaults.json（密文）
// 密码与加解密全部发生在浏览器端，两种模式服务端都只见密文。
import http from "node:http";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const DATA_FILE = join(DATA_DIR, "vaults.json");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const CLOUD = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

// --- 校验（与 functions/handler.mjs 保持一致） ---
const isValidHash = (h) => typeof h === "string" && h.length === 44 && /^[A-Za-z0-9+/=]+$/.test(h);
const isValidEncrypted = (e) =>
  typeof e === "string" && e.length > 100 && e.length < 10 * 1024 * 1024 && /^[A-Za-z0-9+/=]+$/.test(e);

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 11 * 1024 * 1024) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

// ---------- 本地存储：内存 Map + 写透到磁盘（原子替换） ----------
let vaults = new Map(); // id -> { id, passwordHash, encryptedData, createdAt, updatedAt }

async function loadLocalStore() {
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, "utf8"));
    vaults = new Map(raw.map((v) => [v.id, v]));
  } catch {
    vaults = new Map(); // 首次启动或文件损坏时从空库开始
  }
}

async function persistLocal() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify([...vaults.values()], null, 2));
  await (await import("node:fs")).promises.rename(tmp, DATA_FILE);
}

// ---------- 云端存储：Supabase PostgREST ----------
// base64 的 password_hash 含 + / = 字符，进查询参数前必须 encodeURIComponent。
async function db(path, init = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new Error("database_request_failed");
  }
  if (!res.ok) throw new Error("database_request_failed"); // 表未创建/密钥错误统一 503，不泄露细节
  return res;
}

// ---------- 统一存储接口 ----------
const store = {
  async register(passwordHash, encryptedData) {
    const id = randomUUID();
    const now = new Date().toISOString();
    if (CLOUD) {
      await db("vaults", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({ id, password_hash: passwordHash, encrypted_data: encryptedData, created_at: now, updated_at: now }),
      });
    } else {
      vaults.set(id, { id, passwordHash, encryptedData, createdAt: now, updatedAt: now });
      await persistLocal();
    }
    return id;
  },

  async findByPasswordHash(passwordHash) {
    if (CLOUD) {
      const res = await db(`vaults?select=id,encrypted_data&password_hash=eq.${encodeURIComponent(passwordHash)}&limit=1`);
      const rows = await res.json();
      return rows[0] ? { id: rows[0].id, encryptedData: rows[0].encrypted_data } : null;
    }
    for (const v of vaults.values()) {
      if (v.passwordHash === passwordHash) return { id: v.id, encryptedData: v.encryptedData };
    }
    return null;
  },

  async save(id, encryptedData) {
    const now = new Date().toISOString();
    if (CLOUD) {
      const res = await db(`vaults?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({ encrypted_data: encryptedData, updated_at: now }),
      });
      const rows = await res.json();
      return rows.length > 0;
    }
    const v = vaults.get(id);
    if (!v) return false;
    v.encryptedData = encryptedData;
    v.updatedAt = now;
    await persistLocal();
    return true;
  },

  async load(id) {
    if (CLOUD) {
      const res = await db(`vaults?select=id,encrypted_data&id=eq.${encodeURIComponent(id)}&limit=1`);
      const rows = await res.json();
      return rows[0] ? { id: rows[0].id, encryptedData: rows[0].encrypted_data } : null;
    }
    const v = vaults.get(id);
    return v || null;
  },
};

async function handleApi(request, url) {
  const action = url.searchParams.get("action");
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    if (action === "register" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !isValidHash(body.passwordHash) || !isValidEncrypted(body.encryptedData)) {
        return json({ error: "invalid_input" }, 400);
      }
      const id = await store.register(body.passwordHash, body.encryptedData);
      return json({ id });
    }

    if (action === "login" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !isValidHash(body.passwordHash)) return json({ error: "invalid_input" }, 400);
      const found = await store.findByPasswordHash(body.passwordHash);
      if (!found) return json({ error: "not_found" }, 404);
      return json({ id: found.id, encryptedData: found.encryptedData });
    }

    if (action === "save" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !uuidRe.test(body.id || "") || !isValidEncrypted(body.encryptedData)) {
        return json({ error: "invalid_input" }, 400);
      }
      const ok = await store.save(body.id, body.encryptedData);
      if (!ok) return json({ error: "not_found" }, 404);
      return json({ ok: true });
    }

    if (action === "load" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id || !uuidRe.test(id)) return json({ error: "invalid_input" }, 400);
      const found = await store.load(id);
      if (!found) return json({ error: "not_found" }, 404);
      return json({ id: found.id, encryptedData: found.encryptedData });
    }

    return json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "database_request_failed" }, 503);
  }
}

// --- 静态文件 ---
async function serveStatic(pathname) {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(PUBLIC_DIR, rel === "/" || rel === "" ? "index.html" : rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return new Response("forbidden", { status: 403 });
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, "index.html");
    const content = await readFile(filePath);
    return new Response(content, {
      headers: {
        "content-type": MIME[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const response = url.pathname.startsWith("/functions/v1/app")
      ? await handleApi(req, url)
      : req.method === "GET" || req.method === "HEAD"
        ? await serveStatic(url.pathname)
        : new Response("method not allowed", { status: 405 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(req.method === "HEAD" ? undefined : buf);
    } else {
      res.end();
    }
  } catch {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
});

if (!CLOUD) await loadLocalStore();
server.listen(PORT, HOST, () => {
  console.log(`基金金库已启动: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(CLOUD
    ? `存储模式: 云端 Supabase (${SUPABASE_URL})`
    : `存储模式: 本地文件 (${DATA_FILE}) — 设置 SUPABASE_URL + SUPABASE_ANON_KEY 可切云端`);
});
