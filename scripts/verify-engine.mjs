/**
 * 命令行复算：与 public/app.js 的推荐引擎同一套口径，方便离屏核对排序与性能。
 *
 *   node scripts/verify-engine.mjs '{"selected":[518,509],"lanes":[1,4]}'
 *   node scripts/verify-engine.mjs '{"selected":[518,509],"lanes":[1,4],"dedup":true}'
 *   node scripts/verify-engine.mjs '{"selected":[],"lanes":[0,1,2,3,4],"dedup":true}'
 */
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(new URL('../data/snapshot.json', import.meta.url), 'utf8'));
const LN = { 0: '对抗路', 1: '中路', 2: '发育路', 3: '打野', 4: '游走' };

const cfg = JSON.parse(process.argv[2] || '{"selected":[],"lanes":[4]}');
const selected = cfg.selected || [];
const lanes = cfg.lanes || [];
const wWin = cfg.wWin ?? 0.65;
const wPair = cfg.wPair ?? 0.25;
const shrink = cfg.shrink ?? 0.3;
const TOP_N = cfg.top ?? 10;
const dedup = cfg.dedup === true;

const MIN_SAMPLE = 0.3, WIN_CLAMP = 12, WIN_SCALE = 6, MAX_COMBOS = 250000;
const kLane = shrink * 4, kSyn = shrink * 20000, kPair = Math.max(1, shrink * 3000);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/* ------------------------------------------------------------------ 参考位 */
const rawScores = [];
for (const list of Object.values(s.synergy)) for (const e of list) if (e.score > 0) rawScores.push(e.score);
rawScores.sort((a, b) => a - b);
const q = (p) => rawScores[clamp(Math.floor(rawScores.length * p), 0, rawScores.length - 1)];
const REF = { synLo: q(0.05), synMid: q(0.5), synHi: q(0.95) };
function synPartOf(x) {
  const m = REF.synMid;
  const p = x >= m
    ? 50 + (50 * (x - m)) / Math.max(0.001, REF.synHi - m)
    : 50 - (50 * (m - x)) / Math.max(0.001, m - REF.synLo);
  return clamp(p, 0, 100);
}

/* --------------------------------------------------------------- 两两协同 */
const pairIndex = new Map();
for (const [k, list] of Object.entries(s.synergy)) {
  const a = Number(k);
  for (const e of list) {
    const b = e.heroId;
    if (!b || a === b) continue;
    const key = a < b ? a + '_' + b : b + '_' + a;
    const cur = pairIndex.get(key);
    if (!cur || e.totalMatches > cur.matches) pairIndex.set(key, { score: e.score, matches: e.totalMatches });
  }
}
const pairPartOf = (a, b) => {
  const e = pairIndex.get(a < b ? a + '_' + b : b + '_' + a);
  if (!e) return null;
  const conf = e.matches / (e.matches + kPair);
  return { raw: e.score, matches: e.matches, part: synPartOf(REF.synMid + (e.score - REF.synMid) * conf) };
};

/* ------------------------------------------------------- 与已选英雄的协同 */
function synergyFor(cid) {
  const hits = [];
  for (const sid of selected) {
    const f = (s.synergy[sid] || []).find((x) => x.heroId === cid);
    if (f) hits.push({ s: f.score, m: f.totalMatches, key: 'f' + sid });
    const b = (s.synergy[cid] || []).find((x) => x.heroId === sid);
    if (b) hits.push({ s: b.score, m: b.totalMatches, key: 'b' + sid });
  }
  if (!hits.length) return { score: 0, matches: 0, hits: 0 };
  const seen = new Set(); let num = 0, den = 0, maxM = 0;
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    num += h.s * h.m; den += h.m;
    if (h.m > maxM) maxM = h.m;
  }
  const distinct = new Set(hits.map((h) => h.key.slice(1))).size;
  return { score: num / den, matches: maxM, hits: distinct };
}

/* ------------------------------------------------------------------ 分路池 */
function lanePool(lane) {
  const excluded = new Set(selected);
  const cells = [];
  for (const h of s.heroes) {
    if (excluded.has(h.id)) continue;
    const e = s.laneStats[h.id]?.[lane];
    if (!e || !(e.winRate > 0)) continue;
    // 分路样本强度：站点实测的「该英雄在该分路的对局占比」。
    // 不要退回「全局出场率 × 本路占比」估算 —— 分路占比是千强口径而全局出场率随段位变，
    // 实测偏差可达 20 倍以上（鲁班大师游走低估 22 倍、妲己中路高估 32 倍）。
    const n = s.laneSample?.[h.id]?.[lane] ?? (h.pickRate * e.pickRate) / 100;
    if (n < MIN_SAMPLE) continue;
    cells.push({ h, e, n });
  }
  if (!cells.length) return null;

  let sw = 0, swp = 0;
  for (const c of cells) { sw += c.n; swp += c.e.winRate * c.n; }
  const mean = swp / sw;
  const lo = mean - WIN_CLAMP, hi = mean + WIN_CLAMP;

  const rows = cells.map((c) => {
    const confL = Math.pow(c.n / (c.n + kLane), 1.5);
    const rc = clamp(c.e.winRate, lo, hi);
    const adjWin = mean + (rc - mean) * confL;
    const winScore = clamp(50 + (adjWin - mean) * WIN_SCALE, 0, 100);
    const y = synergyFor(c.h.id);
    const confS = y.matches > 0 ? y.matches / (y.matches + kSyn) : 0;
    const adjSyn = REF.synMid + (y.score - REF.synMid) * confS;
    const synPart = synPartOf(adjSyn);
    return {
      hero: c.h, lane, laneMean: mean, win: c.e.winRate, clamped: rc !== c.e.winRate, n: c.n, confL,
      adjWin, winScore, y, adjSyn, synPart,
      memberScore: wWin * winScore + (1 - wWin) * synPart,
    };
  });
  rows.sort((a, b) => b.memberScore - a.memberScore || b.adjWin - a.adjWin);
  return { lane, mean, poolSize: cells.length, rows };
}

/* -------------------------------------------------------------- 组合枚举 */
const pools = lanes.map(lanePool);
if (pools.some((p) => !p)) { console.log('某个分路没有可用候选'); process.exit(0); }
const n = pools.length;
const capK = Math.floor(Math.pow(MAX_COMBOS, 1 / n));
const K = Math.max(6, Math.min(capK, Math.max(...pools.map((p) => p.rows.length))));
const lists = pools.map((p) => p.rows.slice(0, Math.min(K, p.rows.length)));
const pruned = pools.some((p) => p.rows.length > K);

function search(cap, banned) {
  const chosen = new Array(n);
  const used = new Set(banned);
  const pool = [];
  let currentLog = [];
  const push = (memberSum, pairSum, pairCnt) => {
    const memberAvg = memberSum / n;
    const pairPart = pairCnt ? pairSum / pairCnt : 50;
    const score = (1 - wPair) * memberAvg + wPair * pairPart;
    if (pool.length >= cap && score <= pool[pool.length - 1].score) return;
    const rec = { members: chosen.slice(), score, memberAvg, pairPart, pairCnt, log: currentLog.slice() };
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid].score > score) lo = mid + 1; else hi = mid; }
    pool.splice(lo, 0, rec);
    if (pool.length > cap) pool.pop();
  };
  const dfs = (d, memberSum, pairSum, pairCnt) => {
    if (d === n) { push(memberSum, pairSum, pairCnt); return; }
    for (const row of lists[d]) {
      const id = row.hero.id;
      if (used.has(id)) continue;
      let ps = pairSum, pc = pairCnt;
      const savedLog = currentLog;
      currentLog = savedLog.slice();
      for (let j = 0; j < d; j++) {
        const p = pairPartOf(chosen[j].hero.id, id);
        if (p !== null) { ps += p.part; pc++; currentLog.push({ a: chosen[j].hero.name, b: row.hero.name, ...p }); }
      }
      used.add(id); chosen[d] = row;
      dfs(d + 1, memberSum + row.memberScore, ps, pc);
      used.delete(id);
      currentLog = savedLog;
    }
  };
  dfs(0, 0, 0, 0);
  return pool;
}

const t0 = Date.now();
const banned = new Set();
const top = [];
const rounds = dedup ? TOP_N : 1;
for (let r = 0; r < rounds; r++) {
  const found = search(dedup ? 1 : TOP_N, banned);
  if (!found.length) break;
  if (!dedup) { top.push(...found); break; }
  top.push(found[0]);
  for (const m of found[0].members) banned.add(m.hero.id);
}
const ms = Date.now() - t0;

/* ------------------------------------------------------------------ 输出 */
console.log(`口径    分路胜率 / 分路样本量 / 协同指数 = 巅峰千强（站点这些接口不接受段位参数）`);
console.log(`参考位  协同指数 p5=${REF.synLo}  p50=${REF.synMid}  p95=${REF.synHi}`);
console.log(`参数    wWin=${wWin}  wPair=${wPair}  shrink=${shrink}  dedup=${dedup}  kLane=${kLane}  kSyn=${kSyn}  kPair=${kPair}`);
console.log(`已选    ${selected.length ? selected.join(',') : '（空）'}`);
console.log(`分路    ${lanes.map((l) => LN[l]).join(' + ')}   ${n} 人组合`);
console.log(`候选    ${pools.map((p) => p.poolSize).join(' × ')} = ${pools.reduce((a, p) => a * p.poolSize, 1).toLocaleString()} 组` + (pruned ? `（各分路取前 ${K} 名参与组合）` : '') + `   耗时 ${ms}ms`);
console.log();

const pairTotal = (n * (n - 1)) / 2;
top.forEach((c, i) => {
  const name = c.members.map((m) => `${m.hero.name}(${LN[m.lane]})`).join(' + ');
  console.log(`#${String(i + 1).padStart(2)}  组合分 ${c.score.toFixed(1).padStart(5)}   成员均分 ${c.memberAvg.toFixed(1).padStart(5)}   内部协同 ${c.pairCnt ? c.pairPart.toFixed(1) : '无数据'} (${c.pairCnt}/${pairTotal} 对有数据)`);
  console.log(`     ${name}`);
  c.members.forEach((m) => {
    console.log(`       ${m.hero.name.padEnd(7, '　')} ${LN[m.lane]}  胜率 ${m.win.toFixed(1)}%${m.clamped ? '(截断)' : ''}  样本强度 ${m.n.toFixed(2)}  收缩后 ${m.adjWin.toFixed(2)}%(本路均值 ${m.laneMean.toFixed(2)}%)  胜率分 ${m.winScore.toFixed(1)}  协同raw ${m.y.matches ? m.y.score.toFixed(2) : '无'}  协同分 ${m.synPart.toFixed(1)}  成员分 ${m.memberScore.toFixed(1)}`);
  });
  if (c.log && c.log.length) {
    console.log('       内部协同: ' + c.log.map((p) => `${p.a}×${p.b} raw ${p.raw.toFixed(2)}/${p.matches}场 → ${p.part.toFixed(1)}`).join('；'));
  }
  console.log();
});
