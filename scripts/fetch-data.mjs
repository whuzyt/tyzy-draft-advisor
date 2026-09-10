/**
 * 天元之奕数据快照抓取
 *
 * 数据来源：天元之奕数据站 https://tianyuanzhiyi.com （公开接口，无需鉴权）
 *
 * ⚠️ 段位口径（已实测，勿改错）：
 *   - 站点段位编码：1=全分段 3=1350+ 4=顶端排位 5=巅峰千强 8=巅峰百强
 *   - /api/herostats               支持 gameMode → 各段位全局胜率/出场率/禁用率
 *   - /api/herostats/combined      不支持 gameMode → 固定巅峰千强（分路胜率）
 *   - /api/herostats/trends        支持 gameMode；position 参数仅 gameMode=5 可用
 *                                  → 固定巅峰千强（分路绝对出场率）
 *   - /api/hero/analysis/recommend 不支持 gameMode → 固定巅峰千强（协同/克制指数）
 *
 * 产出：data/snapshot.json
 * 用法：node scripts/fetch-data.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'data', 'snapshot.json');

const SITE = 'https://tianyuanzhiyi.com';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  Referer: SITE + '/',
  Accept: 'application/json,text/plain,*/*',
};

export const LANE_NAMES = ['对抗路', '中路', '发育路', '打野', '游走'];

/** 站点段位编码 → 名称（顺序即界面展示顺序） */
export const MODES = [
  { id: 1, name: '全分段' },
  { id: 3, name: '1350+' },
  { id: 4, name: '顶端排位' },
  { id: 5, name: '巅峰千强' },
];

/** 分路与协同数据被站点锁定在这个段位 */
export const LANE_MODE_ID = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(SITE + path, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(400 * (i + 1));
    }
  }
  throw new Error(`${path} -> ${lastErr?.message}`);
}

/** 找到最近一个可用数据日期（数据次日更新，从今天往前找） */
async function resolveLatestDate() {
  const today = new Date();
  for (let back = 0; back <= 6; back++) {
    const d = new Date(today.getTime() - back * 86400000);
    const date = d.toISOString().slice(0, 10);
    try {
      const rows = await getJSON(`/api/herostats?date=${date}&gameMode=1`, { retries: 1 });
      if (Array.isArray(rows) && rows.length > 0) return { date, rows };
    } catch {
      /* 该日无数据，继续往前 */
    }
    await sleep(150);
  }
  throw new Error('最近 7 天内未找到可用的 herostats 数据日期');
}

/** 简单并发池 */
async function pool(items, size, worker, onProgress) {
  const out = new Array(items.length);
  let cursor = 0;
  let done = 0;
  async function run() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = { __error: String(err.message || err) };
      }
      done++;
      if (onProgress && done % 20 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

const num = (v) => Number(v) || 0;

async function main() {
  const t0 = Date.now();
  console.log('[1/6] 解析最新数据日期…');
  const { date } = await resolveLatestDate();
  console.log(`      数据日期 = ${date}`);

  console.log('[2/6] 拉取全英雄列表…');
  const allHeroes = await getJSON('/api/allheroes');
  const heroIds = allHeroes.map((h) => h.id);
  console.log(`      英雄 ${heroIds.length} 个`);

  console.log(`[3/6] 拉取 ${MODES.length} 个段位的全局统计（${MODES.map((m) => m.name).join(' / ')}）…`);
  const globalByMode = {};
  for (const m of MODES) {
    const rows = await getJSON(`/api/herostats?date=${date}&gameMode=${m.id}`);
    const byId = {};
    for (const r of rows) {
      const id = r.baseHeroId ?? r.heroId;
      if (id == null) continue;
      byId[id] = {
        winRate: num(r.winRate),
        pickRate: num(r.pickRate),
        banRate: num(r.banRate),
        power: num(r.qAreaTop10Power),
        delta: num(r.winRateDelta),
      };
    }
    globalByMode[m.id] = byId;
    console.log(`      ${m.name}: ${Object.keys(byId).length} 个英雄`);
    await sleep(120);
  }

  console.log(`[4/6] 逐英雄拉取分路胜率（千强口径，${heroIds.length} 次请求）…`);
  const laneResults = await pool(
    heroIds,
    4,
    async (id) => {
      const d = await getJSON(`/api/herostats/combined?date=${date}&heroId=${id}`);
      await sleep(50);
      return d?.positions && typeof d.positions === 'object' ? d.positions : {};
    },
    (d, t) => process.stdout.write(`\r      ${d}/${t}`)
  );
  process.stdout.write('\n');

  // 只对「combined 里确实存在的分路」取绝对出场率，省掉大量无效请求
  const laneTasks = [];
  laneResults.forEach((lane, i) => {
    if (!lane || lane.__error) return;
    for (const code of Object.keys(lane)) {
      laneTasks.push({ heroId: heroIds[i], code: Number(code), raw: lane[code] });
    }
  });
  console.log(`[5/6] 逐英雄分路拉取绝对出场率（千强 position，${laneTasks.length} 次请求）…`);
  const sampleResults = await pool(
    laneTasks,
    4,
    async (t) => {
      const d = await getJSON(
        `/api/herostats/trends?heroId=${t.heroId}&gameMode=${LANE_MODE_ID}&days=1&position=${t.code}`
      );
      await sleep(50);
      const last = d?.trends?.[d.trends.length - 1];
      return { heroId: t.heroId, code: t.code, pickRate: num(last?.pickRate), winRate: num(last?.winRate) };
    },
    (d, t) => process.stdout.write(`\r      ${d}/${t}`)
  );
  process.stdout.write('\n');

  console.log(`[6/6] 逐英雄拉取协同/克制指数（千强口径，${heroIds.length} 次请求）…`);
  const recResults = await pool(
    heroIds,
    4,
    async (id) => {
      const q = encodeURIComponent(JSON.stringify([id]));
      const d = await getJSON(`/api/hero/analysis/recommend?heroIds=${q}`);
      await sleep(50);
      const r = d?.recommendations || {};
      return {
        synergies: Array.isArray(r.synergies) ? r.synergies : [],
        counters: Array.isArray(r.counters) ? r.counters : [],
      };
    },
    (d, t) => process.stdout.write(`\r      ${d}/${t}`)
  );
  process.stdout.write('\n');

  console.log('组装快照…');
  const heroes = [];
  const laneStats = {};
  const laneSample = {};
  const synergy = {};
  const counters = {};

  allHeroes.forEach((h, i) => {
    const lane = laneResults[i];
    const rec = recResults[i];

    const cleanLane =
      lane && !lane.__error
        ? Object.fromEntries(
            Object.entries(lane).map(([code, v]) => [
              code,
              { pickRate: num(v?.pickRate), winRate: num(v?.winRate) },
            ])
          )
        : {};

    laneStats[h.id] = cleanLane;

    const pick = (list) =>
      (Array.isArray(list) ? list : []).map((x) => ({
        heroId: x.heroId,
        heroName: x.heroName,
        score: num(x.score),
        totalMatches: num(x.totalMatches),
        appearance: num(x.appearance),
      }));

    synergy[h.id] = rec && !rec.__error ? pick(rec.synergies) : [];
    counters[h.id] = rec && !rec.__error ? pick(rec.counters) : [];

    const g = globalByMode[LANE_MODE_ID]?.[h.id] || {};
    heroes.push({
      id: h.id,
      name: h.name,
      avatarUrl: h.avatarUrl || '',
      roles: h.roles || '',
      winRate: num(g.winRate),
      pickRate: num(g.pickRate),
      banRate: num(g.banRate),
      winRateDelta: num(g.delta),
      qAreaTop10Power: num(g.power),
      laneCodes: Object.keys(cleanLane).map(Number).sort((a, b) => a - b),
    });
  });

  // 分路绝对出场率（= 该英雄在该分路的对局占比，同分路所有英雄之和 ≈ 200%，因每局两边各 1 人）
  for (const r of sampleResults) {
    if (r?.__error) continue;
    (laneSample[r.heroId] ||= {})[r.code] = r.pickRate;
  }

  const failedLane = laneResults.filter((r) => r?.__error).length;
  const failedRec = recResults.filter((r) => r?.__error).length;
  const failedSample = sampleResults.filter((r) => r?.__error).length;

  const snapshot = {
    meta: {
      sourceName: '天元之奕数据站',
      sourceUrl: 'https://tianyuanzhiyi.com',
      notice: '数据版权归天元之奕数据站所有，仅供个人查询参考，请勿商用',
      dataDate: date,
      fetchedAt: new Date().toISOString(),
      heroCount: heroes.length,
      failedLaneCount: failedLane,
      failedSynergyCount: failedRec,
      failedSampleCount: failedSample,
      laneNames: LANE_NAMES,
      modes: MODES,
      laneModeId: LANE_MODE_ID,
      elapsedMs: Date.now() - t0,
    },
    heroes,
    globalByMode,
    laneStats,
    laneSample,
    synergy,
    counters,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot), 'utf8');

  console.log(
    `\n完成 → ${OUT}\n  英雄 ${heroes.length} 个 | 分路失败 ${failedLane} | 分路样本失败 ${failedSample} | 协同失败 ${failedRec} | 耗时 ${(
      (Date.now() - t0) / 1000
    ).toFixed(1)}s`
  );
}

main().catch((err) => {
  console.error('抓取失败：', err);
  process.exit(1);
});
