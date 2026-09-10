/**
 * 本地服务：静态托管 + 接口反代 + 数据刷新
 *
 * 为什么需要它：
 *   天元之奕的接口没有 CORS 响应头，浏览器从本地页面直连会被拦截，
 *   所以由本地服务代取，同时做内存缓存，避免频繁打到对方站点。
 *
 * 零依赖，只用 Node 内置模块。默认监听 127.0.0.1:8787。
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const SNAPSHOT = join(__dirname, 'data', 'snapshot.json');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);

const UPSTREAM = 'https://tianyuanzhiyi.com';
const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  Referer: UPSTREAM + '/',
  Accept: 'application/json,text/plain,*/*',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------------- 内存缓存 ---------------- */
const cache = new Map(); // key -> { at, ttl, body }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}
function cacheSet(key, body, ttl) {
  cache.set(key, { at: Date.now(), ttl, body });
}

/* ---------------- 工具 ---------------- */
function sendJSON(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function upstream(path) {
  const res = await fetch(UPSTREAM + path, { headers: UPSTREAM_HEADERS });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`上游 ${res.status}`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  return JSON.parse(text);
}

/* ---------------- 路由 ---------------- */
async function handleAPI(req, res, url) {
  const { pathname, searchParams } = url;

  // 快照
  if (pathname === '/api/snapshot') {
    const cached = cacheGet('snapshot');
    if (cached) return sendJSON(res, 200, cached);
    try {
      const raw = await readFile(SNAPSHOT, 'utf8');
      const parsed = JSON.parse(raw);
      cacheSet('snapshot', parsed, 60_000);
      return sendJSON(res, 200, parsed);
    } catch {
      return sendJSON(res, 404, {
        error: '尚未生成数据快照，请先运行 npm run fetch 或在页面上点击「刷新数据」',
      });
    }
  }

  // 实时协同/克制指数（多英雄组合查询走这里）
  if (pathname === '/api/recommend') {
    const heroIds = searchParams.get('heroIds');
    if (!heroIds) return sendJSON(res, 400, { error: '缺少 heroIds 参数' });
    let parsed;
    try {
      parsed = JSON.parse(heroIds);
    } catch {
      return sendJSON(res, 400, { error: 'heroIds 必须是 JSON 数组' });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return sendJSON(res, 400, { error: 'heroIds 不能为空' });
    }
    if (parsed.length > 5) {
      return sendJSON(res, 400, { error: '一次最多 5 个英雄（上游限制）' });
    }

    const key = 'rec:' + [...parsed].sort((a, b) => a - b).join(',');
    const cached = cacheGet(key);
    if (cached) return sendJSON(res, 200, { ...cached, __cached: true });

    try {
      const q = encodeURIComponent(JSON.stringify(parsed));
      const data = await upstream(`/api/hero/analysis/recommend?heroIds=${q}`);
      cacheSet(key, data, 10 * 60_000);
      return sendJSON(res, 200, data);
    } catch (err) {
      return sendJSON(res, err.status || 502, {
        error: '上游查询失败',
        detail: err.body || String(err.message),
      });
    }
  }

  // 刷新快照
  if (pathname === '/api/refresh' && req.method === 'POST') {
    if (refreshState.running) {
      return sendJSON(res, 409, { error: '正在刷新中', ...refreshState });
    }
    refreshState.running = true;
    refreshState.startedAt = new Date().toISOString();
    refreshState.output = '';
    refreshState.error = null;

    const child = spawn(process.execPath, [join(__dirname, 'scripts', 'fetch-data.mjs')], {
      cwd: __dirname,
    });
    const keep = (buf) => {
      refreshState.output = (refreshState.output + buf.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => {
      refreshState.running = false;
      refreshState.finishedAt = new Date().toISOString();
      refreshState.exitCode = code;
      if (code !== 0) refreshState.error = '抓取脚本非正常退出，详见日志';
      cache.delete('snapshot');
    });

    return sendJSON(res, 202, { ok: true, ...refreshState });
  }

  if (pathname === '/api/refresh/status') {
    return sendJSON(res, 200, refreshState);
  }

  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, upstream: UPSTREAM });
  }

  return sendJSON(res, 404, { error: '未知接口', pathname });
}

const refreshState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  error: null,
  output: '',
};

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // 只放行 public/ 与 data/ 两个前缀，防目录穿越
  let baseDir;
  if (rel.startsWith('/data/')) {
    baseDir = __dirname;
    rel = rel.slice(5);
  } else {
    baseDir = PUBLIC_DIR;
    rel = rel.slice(1);
  }

  const target = normalize(join(baseDir, rel));
  if (!target.startsWith(baseDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleAPI(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    return await handleStatic(req, res, url);
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`天元之奕补位推荐 → http://${HOST}:${PORT}`);
  console.log(`数据来源：${UPSTREAM}（快照 + 实时反代）`);
});
