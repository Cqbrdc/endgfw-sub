/**
 * end-gfw 免费节点聚合订阅 —— Cloudflare Worker（零依赖版：不需要 KV、不需要 CLI）
 * ------------------------------------------------------------------
 * 数据来源（并发抓取后合并去重）：
 *   1) 镜像站 /api/free   https://54.255.198.102/api/free  https://13.212.84.197/api/free
 *   2) 官方订阅（同一份节点的 GitHub 镜像，作为兜底）
 *
 * 路由
 *   /            混合订阅（base64）→ v2rayN / Hiddify 直接添加
 *   /plain       明文节点列表
 *   /ss          仅 Shadowsocks（base64）
 *   /outline     Shadowsocks 逐条复制 + 二维码（Outline 用）
 *   /stats       抓取统计 JSON
 *   /refresh     手动刷新（可选 token：部署变量 REFRESH_TOKEN）
 *
 * 定时：每 2 小时执行一次，cron 表达式见 wrangler.toml（UTC）
 *       Dashboard 部署时，在 Settings → Triggers → Cron Triggers 里添加同样的表达式
 *
 * 存储：不用 KV。聚合结果放进 Cache API（每个数据中心独立，TTL 6 小时），
 *       定时任务刷新一次，客户端访问时直接命中缓存。
 * ------------------------------------------------------------------
 */

const CONFIG = {
  // 镜像站（/api/free 返回 JSON：{ nodes: [{protocol, name, uri}], mirrors: [...] }）
  // 站点本身会通过 mirrors 字段公布新镜像，脚本会自动发现并加入抓取，不用手动维护
  mirrors: ["https://54.255.198.102/", "https://13.212.84.197/"],
  apiFree: "/api/free",
  // 官方聚合订阅：只有当所有镜像站都抓不到单节点时才兜底使用
  officialSub: "https://raw.githubusercontent.com/hello-world-1989/cn-news/main/end-gfw-free",
  maxNodes: 300,
  cacheTtl: 7200, // 与 cron 频率一致：2 小时
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const NODE_RE =
  /(?:vmess|vless|trojan|ssr?|hysteria2?|hy2|tuic|anytls):\/\/[^\s"'<>`\\]+/gi;
const CACHE_URL = "https://endgfw-cache.internal/state";

/* ----------------------------- 入口 ----------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/refresh") {
      if (env.REFRESH_TOKEN && url.searchParams.get("token") !== env.REFRESH_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      const state = await refreshOnce();
      return json({ ok: true, ...state.meta });
    }

    const state = await loadState();
    if (path === "/stats") return json(state.meta);

    const common = {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
      "x-updated-at": state.meta.updatedAt || "",
      "x-node-count": String(state.mixed.length),
    };

    switch (path) {
      case "/ss":
        return subResponse(state.ss, "end-gfw SS 节点", common);
      case "/plain":
        return new Response(state.mixed.join("\n"), {
          headers: { ...common, "content-type": "text/plain; charset=utf-8" },
        });
      case "/outline":
        return new Response(renderOutline(state), {
          headers: { ...common, "content-type": "text/html; charset=utf-8" },
        });
      default:
        return subResponse(state.mixed, "end-gfw 聚合节点", common);
    }
  },

  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(refreshOnce());
  },
};

/* --------------------------- 缓存（替代 KV） --------------------------- */

let mem = { mixed: null, ss: null, meta: null };
let inflight = null;

async function loadState() {
  if (mem.mixed?.length) return mem;
  const hit = await caches.default.match(CACHE_URL).catch(() => null);
  if (hit) {
    const state = await hit.json().catch(() => null);
    if (state?.mixed?.length) {
      mem = state;
      return state;
    }
  }
  return refreshOnce();
}

function refreshOnce() {
  if (!inflight) inflight = doRefresh().finally(() => (inflight = null));
  return inflight;
}

async function doRefresh() {
  const started = Date.now();
  const { uris, sources, meta: collectMeta } = await collect();
  const mixed = dedupeAndFilter(uris);
  const ss = mixed.filter((u) => /^ss:\/\//i.test(u));
  const state = {
    mixed,
    ss,
    meta: {
      updatedAt: new Date().toISOString(),
      total: mixed.length,
      ss: ss.length,
      sources,
      ...collectMeta,
      ms: Date.now() - started,
      errors:
        mixed.length === 0
          ? "没有抓到单节点：所有镜像站与官方订阅兜底都失败了"
          : undefined,
    },
  };

  mem = state;
  await caches.default
    .put(CACHE_URL, new Response(JSON.stringify(state), { headers: { "cache-control": `max-age=${CONFIG.cacheTtl}` } }))
    .catch(() => {});

  return state;
}

/* ----------------------------- 抓取 ----------------------------- */

async function collect() {
  const uris = [];
  const sources = [];
  const visited = new Set(); // 已经处理过的镜像站

  // 1) 抓镜像站的 /api/free（单节点）；每台镜像的 mirrors 字段里会公布新镜像，
  //    自动发现后追加抓一轮，最多两轮，镜像地址变了也不用改代码
  let pending = [...CONFIG.mirrors];

  for (let round = 0; round < 2 && pending.length; round++) {
    const batch = pending.splice(0, 6);
    batch.forEach((m) => visited.add(m.replace(/\/+$/, "")));
    const results = await Promise.allSettled(batch.map((m) => fetchJson(new URL(CONFIG.apiFree, m).toString())));

    const discovered = [];
    results.forEach((r, i) => {
      const url = new URL(CONFIG.apiFree, batch[i]).toString();
      if (r.status !== "fulfilled" || !r.value) {
        sources.push({ url, nodes: 0, ok: false });
        return;
      }
      const list = (r.value.nodes || []).map((n) => n.uri).filter(Boolean);
      sources.push({ url, nodes: list.length, ok: true });
      uris.push(...list);
      for (const m of r.value.mirrors || []) {
        const origin = String(m).replace(/\/+$/, "");
        if (/^https?:\/\//.test(origin) && !visited.has(origin) && !discovered.includes(origin)) {
          discovered.push(origin);
        }
      }
    });
    pending = discovered;
  }

  // 2) 所有镜像都没抓到单节点 → 用官方订阅兜底
  let fallback = false;
  if (uris.length === 0) {
    fallback = true;
    const text = await fetchText(CONFIG.officialSub);
    const list = text ? extractNodes(text) : [];
    sources.push({ url: CONFIG.officialSub, nodes: list.length, ok: list.length > 0, fallback: true });
    uris.push(...list);
  }

  const meta = { fallback, mirrorsTried: [...visited] };
  return { uris, sources, meta };
}

async function fetchJson(url) {
  const text = await fetchText(url);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "application/json,text/html,text/plain,*/*" },
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // https 失败（比如证书校验不过）时退回 http 再试一次
    try {
      const res = await fetch(url.replace(/^https:/, "http:"), {
        redirect: "follow",
        headers: { "user-agent": UA, accept: "application/json,text/html,text/plain,*/*" },
        cf: { cacheTtl: 0 },
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
}

/* --------------------------- 解析 / 去重 --------------------------- */

function extractNodes(text) {
  const out = [];
  const decoded = decodeEntities(text);

  let m;
  const re = new RegExp(NODE_RE.source, "gi");
  while ((m = re.exec(decoded))) out.push(cleanUri(m[0]));

  // 兼容内嵌 base64 订阅块
  const b64re = /[A-Za-z0-9+/]{80,}={0,2}/g;
  let b;
  while ((b = b64re.exec(decoded))) {
    const inner = b64decode(b[0]);
    if (!inner || !inner.includes("://")) continue;
    const re2 = new RegExp(NODE_RE.source, "gi");
    let n;
    while ((n = re2.exec(inner))) out.push(cleanUri(n[0]));
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2f;/gi, "/");
}

function cleanUri(u) {
  return u.trim().replace(/[),.;'"]+$/, "").replace(/&amp;/g, "&");
}

function dedupeAndFilter(uris) {
  const out = [];
  const seen = new Set();
  for (const raw of uris) {
    const node = parseNode(raw);
    if (!node) continue;
    const key = `${node.scheme}|${node.host}|${node.port}|${hash(node.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= CONFIG.maxNodes) break;
  }
  return out;
}

function parseNode(uri) {
  try {
    const scheme = uri.slice(0, uri.indexOf("://")).toLowerCase();
    if (scheme === "vmess") {
      const json = b64decode(uri.slice(8).replace(/#.*$/, "").split("?")[0]);
      if (!json) return null;
      const o = JSON.parse(json);
      const host = String(o.add || "").trim();
      const port = Number(o.port);
      if (!validHost(host) || !validPort(port)) return null;
      return { scheme, host: host.toLowerCase(), port, id: String(o.id || "") };
    }
    if (scheme === "ss" || scheme === "ssr") {
      const p = parseSS(uri);
      return p ? { scheme: "ss", ...p } : null;
    }
    const u = new URL(uri);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const port = Number(u.port || 443);
    if (!validHost(host) || !validPort(port)) return null;
    return {
      scheme,
      host: host.toLowerCase(),
      port,
      id: decodeURIComponent(u.username || "") + ":" + decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

function parseSS(uri) {
  const raw = uri.slice(5).split("#")[0].split("?")[0];
  let host = "";
  let port = 0;
  let secret = "";

  if (raw.includes("@")) {
    const at = raw.lastIndexOf("@");
    const left = raw.slice(0, at);
    const hp = raw.slice(at + 1).match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!hp) return null;
    host = hp[1];
    port = Number(hp[2]);
    secret = left.includes(":") ? safeDecodeURI(left) : b64decode(left) || left;
  } else {
    const dec = b64decode(raw);
    if (!dec || !dec.includes("@")) return null;
    const at = dec.lastIndexOf("@");
    const hp = dec.slice(at + 1).match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!hp) return null;
    host = hp[1];
    port = Number(hp[2]);
    secret = dec.slice(0, at);
  }
  if (!validHost(host) || !validPort(port)) return null;
  return { host: host.toLowerCase(), port, id: secret };
}

function validPort(p) {
  return Number.isInteger(p) && p > 0 && p < 65536;
}

function validHost(h) {
  if (!h || h.length > 253) return false;
  const host = h.toLowerCase();
  if (["localhost", "0.0.0.0", "::1", "::", "127.0.0.1"].includes(host)) return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^(fc|fd|fe80)/.test(host)) return false;
  return true;
}

function safeDecodeURI(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ----------------------------- 输出 ----------------------------- */

function subResponse(list, title, common) {
  return new Response(b64encode(list.join("\n")), {
    headers: {
      ...common,
      "content-type": "text/plain; charset=utf-8",
      "profile-title": "base64:" + b64encode(title),
      "profile-update-interval": "2",
    },
  });
}

function renderOutline(state) {
  const rows = state.ss
    .map((u, i) => {
      const qr = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(u);
      return `<div class="item">
        <div class="head"><span>#${i + 1}</span><button onclick="cp(this)">复制 ss://</button></div>
        <code>${escapeHtml(u)}</code>
        <img loading="lazy" src="${qr}" alt="qr">
      </div>`;
    })
    .join("\n");

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Outline 节点（${state.ss.length}）</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:16px;background:#0f1115;color:#e6e6e6}
h1{font-size:18px;margin:0 0 4px}p{color:#9aa0a6;font-size:13px;margin:0 0 16px}
.item{background:#181b22;border-radius:10px;padding:12px;margin-bottom:12px}
.head{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#9aa0a6;margin-bottom:8px}
code{display:block;word-break:break-all;font-size:11px;line-height:1.5;color:#9fe8b0;background:#0b0d11;padding:8px;border-radius:6px}
img{display:block;margin:10px auto 0;background:#fff;padding:6px;border-radius:8px}
button{background:#2a6df5;color:#fff;border:0;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
</style></head><body>
<h1>Outline 可用节点：${state.ss.length} 个</h1>
<p>更新于 ${escapeHtml(state.meta?.updatedAt || "-")}。Outline 不支持订阅链接，请点「复制」后在 Outline 里 Add Server → 粘贴，或扫码。</p>
${rows || "<p>本次没有抓到 ss:// 节点（Outline 只支持 Shadowsocks）。</p>"}
<script>
function cp(btn){
  const code = btn.closest('.item').querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(()=>{btn.textContent='已复制';setTimeout(()=>btn.textContent='复制 ss://',1200)});
}
</script></body></html>`;
}

/* ----------------------------- 工具 ----------------------------- */

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(str) {
  if (!str) return null;
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const pad = s.length % 4;
  if (pad === 1) return null;
  if (pad) s += "=".repeat(4 - pad);
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function json(o) {
  return new Response(JSON.stringify(o, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}
