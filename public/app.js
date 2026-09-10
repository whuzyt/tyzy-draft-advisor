/* 天元之奕 · 补位推荐 —— 前端与推荐引擎 */

const LANES = [
  { code: 0, name: '对抗路' },
  { code: 1, name: '中路' },
  { code: 2, name: '发育路' },
  { code: 3, name: '打野' },
  { code: 4, name: '游走' },
];
const LANE_NAME = Object.fromEntries(LANES.map((l) => [l.code, l.name]));

/**
 * 段位口径（站点实测，勿想当然）：
 *   - /api/herostats               支持 gameMode → 各段位全局胜率/出场率/禁用率（本页的「参考段位」切换它）
 *   - /api/herostats/combined      不支持 gameMode → 分路胜率恒为巅峰千强
 *   - /api/herostats/trends        position 参数仅 gameMode=5 可用 → 分路样本量恒为巅峰千强
 *   - /api/hero/analysis/recommend 不支持 gameMode → 协同/克制指数恒为巅峰千强
 * 所以「参考段位」只影响英雄池排序与全局数据的展示，不影响排序算法的主指标。
 */
const modeList = () => state.snap?.meta?.modes || [{ id: 5, name: '巅峰千强' }];
const modeNameOf = (id) => modeList().find((m) => m.id === id)?.name || '—';
/** 当前参考段位下的英雄全局数据 */
function globalOf(id) {
  return state.snap?.globalByMode?.[state.modeId]?.[id] || null;
}
/** 分路样本强度 = 该英雄在该分路的对局占比（站点实测值，千强口径） */
function laneSampleOf(hero, laneCode, e) {
  const v = state.snap?.laneSample?.[hero.id]?.[laneCode];
  if (typeof v === 'number' && v > 0) return v;
  return hero.pickRate * (e.pickRate / 100);
}

const TOP_N = 10;

const state = {
  snap: null,
  heroById: new Map(),
  pairIndex: new Map(),
  selected: [],
  lanes: [],
  poolLane: 'all',
  keyword: '',
  wWin: 0.65,
  wPair: 0.25,
  shrink: 0.3,
  dedup: false,
  modeId: 5,
  liveKey: null,
  liveMap: null,
  liveState: 'idle', // idle | ok | fail
  pending: 0,
};

const $ = (id) => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => new Intl.NumberFormat('zh-CN').format(Math.round(n));
const pct = (n) => (Number(n) || 0).toFixed(1) + '%';

/* ------------------------------------------------------------------ 数据加载 */

async function loadSnapshot() {
  const res = await fetch('/api/snapshot');
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || '快照加载失败');
  }
  state.snap = await res.json();
  state.heroById = new Map(state.snap.heroes.map((h) => [h.id, h]));
  computeRefs();
  state.pairIndex = buildPairIndex();
}

/* ---------------------------------------------------------- 实时协同指数查询 */

async function ensureLive() {
  const ids = [...state.selected].sort((a, b) => a - b);
  if (!ids.length) {
    state.liveKey = '';
    state.liveMap = null;
    state.liveState = 'idle';
    return;
  }
  const key = ids.join(',');
  if (state.liveKey === key) return;

  state.liveKey = key;
  try {
    const q = encodeURIComponent(JSON.stringify(ids));
    const res = await fetch('/api/recommend?heroIds=' + q);
    if (!res.ok) throw new Error('upstream');
    const data = await res.json();
    const list = data?.recommendations?.synergies || [];
    state.liveMap = new Map(list.map((x) => [x.heroId, x]));
    state.liveState = 'ok';
  } catch {
    state.liveMap = null;
    state.liveState = 'fail';
  }
}

/**
 * 取候选英雄相对已选阵容的协同指数。
 * 三个来源按优先级合并：
 *   1) 实时接口：多英雄组合查询，保真度最高
 *   2) 正向快照：已选英雄的共现列表里是否有该候选
 *   3) 反向快照：该候选的共现列表里是否有已选英雄（补全覆盖）
 * 命中项按共现场次加权平均。
 */
function synergyFor(candidateId) {
  const hits = [];

  if (state.liveMap && state.liveMap.has(candidateId)) {
    const e = state.liveMap.get(candidateId);
    hits.push({ score: e.score, matches: e.totalMatches, pair: `live:${candidateId}` });
  }

  for (const s of state.selected) {
    const fwd = (state.snap.synergy[s] || []).find((x) => x.heroId === candidateId);
    if (fwd) hits.push({ score: fwd.score, matches: fwd.totalMatches, pair: `fwd:${s}` });

    const back = (state.snap.synergy[candidateId] || []).find((x) => x.heroId === s);
    if (back) hits.push({ score: back.score, matches: back.totalMatches, pair: `bwd:${s}` });
  }

  if (!hits.length) return { score: 0, matches: 0, hits: 0, src: 'none' };

  const seen = new Set();
  let num = 0;
  let den = 0;
  let maxM = 0;
  for (const h of hits) {
    if (seen.has(h.pair)) continue;
    seen.add(h.pair);
    num += h.score * h.matches;
    den += h.matches;
    if (h.matches > maxM) maxM = h.matches;
  }
  const distinct = new Set(hits.map((h) => h.pair.split(':')[1])).size;
  const src = hits.some((h) => h.pair.startsWith('live:')) ? 'live' : 'snapshot';
  return { score: num / den, matches: maxM, hits: distinct, src };
}

/* -------------------------------------------------------------- 推荐引擎核心 */

/**
 * 打分口径（结果都是 0-100 的「排序分」，不是胜率）
 *
 *   成员得分 memberScore = w₁ × 分路胜率得分 + w₂ × 协同指数得分
 *
 *   分路胜率得分：以【本路均值】为 50 分，用统一斜率缩放 ——
 *     50 + (收缩后胜率 − 本路均值) × WIN_SCALE
 *     用统一斜率而不是候选集 min-max，是为了让「中路 80 分」和「游走 80 分」可比，
 *     多分路组合打分时不会因为某一路整体更卷而被压低。
 *
 *   协同指数得分：以快照自身分布的 p50 为中性点 50 分，p5 / p95 为两端线性映射。
 *     （实测该指数 100% 为正、中位数约 2.0，「0 即中性」是错的，会把所有人往高位挤）
 *     无共现数据 = 50 分，不奖不罚。
 *
 *   组合得分 comboScore = (1−λ) × 成员得分均值 + λ × 内部协同得分
 *     内部协同得分 = 组合内【两名新英雄之间】的协同指数，同一套映射口径，无数据 = 50。
 *     选 1 个分路时没有内部对，comboScore = 该英雄的 memberScore。
 *
 * 三道闸防止冷门小样本虚高：
 *   ① 候选门槛：分路样本强度 n < MIN_SAMPLE 的候选不进池（该路基本不打）
 *   ② 异常截断：原始分路胜率截断到 [本路均值 ± WIN_CLAMP] 内
 *   ③ 样本收缩：收缩后胜率 = 本路均值 + (截断后胜率 − 本路均值) × conf^1.5，conf = n/(n+kLane)
 *      n = 该英雄在该分路的对局占比，取站点实测值（巅峰千强 position 接口，同分路全体之和≈200%，
 *          因每局该分路双方各 1 人）。**不要再用「全局出场率 × 本路占比」去估** ——
 *          那要求两个接口同口径，而分路占比是千强、全局出场率会随段位变，
 *          实测偏差可达 20 倍以上（鲁班大师游走被低估 22 倍、妲己中路被高估 32 倍）。
 *      协同指数同理由 raw 向 p50 收缩：adj = p50 + (raw − p50) × conf
 */
const MIN_SAMPLE = 0.3;
const WIN_CLAMP = 12;
const WIN_SCALE = 6;
const MAX_COMBOS = 250000;

/** 协同指数参考位（由快照自身分布算出，保证跨批次口径稳定） */
const REF = { synLo: 0.9, synMid: 2.0, synHi: 5.5, ready: false };

function computeRefs() {
  const vals = [];
  for (const list of Object.values(state.snap.synergy)) {
    for (const e of list) if (e.score > 0) vals.push(e.score);
  }
  vals.sort((a, b) => a - b);
  const q = (p) => vals[clamp(Math.floor(vals.length * p), 0, vals.length - 1)];
  if (vals.length > 20) {
    REF.synLo = q(0.05);
    REF.synMid = q(0.5);
    REF.synHi = q(0.95);
  }
  if (!(REF.synMid > REF.synLo)) REF.synMid = REF.synLo + 0.5;
  if (!(REF.synHi > REF.synMid)) REF.synHi = REF.synMid + 1;
  REF.ready = true;
}

/** 协同指数 → 0-100 排序分，p50 处恰好 50 分 */
function synPartOf(x) {
  const m = REF.synMid;
  const p =
    x >= m
      ? 50 + (50 * (x - m)) / Math.max(0.001, REF.synHi - m)
      : 50 - (50 * (m - x)) / Math.max(0.001, m - REF.synLo);
  return clamp(p, 0, 100);
}

/** 全英雄两两协同索引。实测双向 score 完全一致，同一条对只留共现场次更大的那次。 */
function buildPairIndex() {
  const map = new Map();
  for (const [k, list] of Object.entries(state.snap.synergy)) {
    const a = Number(k);
    for (const e of list) {
      const b = e.heroId;
      if (!b || a === b) continue;
      const key = a < b ? a + '_' + b : b + '_' + a;
      const cur = map.get(key);
      if (!cur || e.totalMatches > cur.matches) map.set(key, { score: e.score, matches: e.totalMatches });
    }
  }
  return map;
}

/** 单个分路的候选池与成员得分（供组合枚举使用） */
function lanePool(laneCode) {
  const kLane = state.shrink * 4;
  const kSyn = state.shrink * 20000;
  const excluded = new Set(state.selected);

  const cells = [];
  for (const h of state.snap.heroes) {
    if (excluded.has(h.id)) continue;
    const e = state.snap.laneStats[h.id]?.[laneCode];
    if (!e || !(e.winRate > 0)) continue;
    const n = laneSampleOf(h, laneCode, e);
    if (n < MIN_SAMPLE) continue;
    cells.push({ hero: h, e, n });
  }
  if (!cells.length) return null;

  let sw = 0;
  let swp = 0;
  for (const c of cells) {
    sw += c.n;
    swp += c.e.winRate * c.n;
  }
  const meanWin = sw ? swp / sw : 50;
  const lo = meanWin - WIN_CLAMP;
  const hi = meanWin + WIN_CLAMP;

  const rows = cells.map((c) => {
    const confL = kLane === 0 ? 1 : Math.pow(c.n / (c.n + kLane), 1.5);
    const rawClamped = clamp(c.e.winRate, lo, hi);
    const adjWin = meanWin + (rawClamped - meanWin) * confL;
    const winScore = clamp(50 + (adjWin - meanWin) * WIN_SCALE, 0, 100);

    const syn = synergyFor(c.hero.id);
    const confS = syn.matches > 0 ? syn.matches / (syn.matches + kSyn) : 0;
    const adjSyn = REF.synMid + (syn.score - REF.synMid) * confS;
    const synPart = synPartOf(adjSyn);

    return {
      hero: c.hero,
      laneCode,
      laneMean: meanWin,
      winRate: c.e.winRate,
      clamped: rawClamped !== c.e.winRate,
      laneShare: c.e.pickRate,
      sample: c.n,
      confL,
      adjWin,
      winScore,
      synScore: syn.score,
      synMatches: syn.matches,
      synHits: syn.hits,
      synSrc: syn.src,
      adjSyn,
      synPart,
      memberScore: state.wWin * winScore + (1 - state.wWin) * synPart,
    };
  });

  rows.sort((a, b) => b.memberScore - a.memberScore || b.adjWin - a.adjWin);
  return { laneCode, meanWin, poolSize: cells.length, rows };
}

/**
 * 组合推荐：把选中的 N 个分路各派一名英雄，枚举所有组合，按 comboScore 取 Top10。
 * 组合内不允许出现重复英雄（同一英雄不能同时占两个位）。
 * 组合规模爆炸时按各分路成员得分先截取前 K 名，保证单次计算量可控。
 */
function recommendCombos() {
  const lanes = state.lanes;
  if (!lanes.length) return null;

  const perLane = lanes.map(lanePool);
  if (perLane.some((p) => !p)) return null;

  const n = perLane.length;
  // 每个分路最多派 K 名候选参与组合，保证 K^n 不爆；分路候选不足 K 的按实际数量走
  const capK = Math.floor(Math.pow(MAX_COMBOS, 1 / n));
  const K = Math.max(6, Math.min(capK, Math.max(...perLane.map((p) => p.rows.length))));
  const lists = perLane.map((p) => p.rows.slice(0, Math.min(K, p.rows.length)));
  const pruned = perLane.some((p) => p.rows.length > K);

  const lam = state.wPair;
  const kPair = Math.max(1, state.shrink * 3000);
  const lookups = { hit: 0, miss: 0 };
  const pairPartOf = (a, b) => {
    const e = state.pairIndex.get(a < b ? a + '_' + b : b + '_' + a);
    if (!e) {
      lookups.miss++;
      return null;
    }
    lookups.hit++;
    const conf = e.matches / (e.matches + kPair);
    return synPartOf(REF.synMid + (e.score - REF.synMid) * conf);
  };

  /** 枚举所有组合，命中最优的 cap 个并降序返回；banned 里的英雄本轮不参与 */
  const search = (cap, banned) => {
    const chosen = new Array(n);
    const used = new Set(banned);
    const pool = [];

    const push = (memberSum, pairSum, pairCnt) => {
      const memberAvg = memberSum / n;
      const pairPart = pairCnt ? pairSum / pairCnt : 50;
      const score = (1 - lam) * memberAvg + lam * pairPart;
      if (pool.length >= cap && score <= pool[pool.length - 1].score) return;
      const rec = { members: chosen.slice(), score, memberAvg, pairPart, pairCnt };
      let lo = 0;
      let hi = pool.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pool[mid].score > score) lo = mid + 1;
        else hi = mid;
      }
      pool.splice(lo, 0, rec);
      if (pool.length > cap) pool.pop();
    };

    const dfs = (d, memberSum, pairSum, pairCnt) => {
      if (d === n) {
        push(memberSum, pairSum, pairCnt);
        return;
      }
      const list = lists[d];
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        const id = row.hero.id;
        if (used.has(id)) continue;
        let ps = pairSum;
        let pc = pairCnt;
        for (let j = 0; j < d; j++) {
          const p = pairPartOf(chosen[j].hero.id, id);
          if (p !== null) {
            ps += p;
            pc++;
          }
        }
        used.add(id);
        chosen[d] = row;
        dfs(d + 1, memberSum + row.memberScore, ps, pc);
        used.delete(id);
      }
    };
    dfs(0, 0, 0, 0);
    return pool;
  };

  // 去重模式：每轮取「不与已上榜单英雄重复」的最优方案，再把它的人拉黑后重算，
  // 保证 Top10 是一套互不抢人的方案，而不是同一个强英雄刷屏。
  const banned = new Set();
  const top = [];
  const rounds = state.dedup ? TOP_N : 1;
  for (let r = 0; r < rounds; r++) {
    const found = search(state.dedup ? 1 : TOP_N, banned);
    if (!found.length) break;
    if (!state.dedup) {
      top.push(...found);
      break;
    }
    top.push(found[0]);
    for (const m of found[0].members) banned.add(m.hero.id);
  }

  return { lanes, perLane, n, K, pruned, top, lam, lookups };
}

/* ------------------------------------------------------------------ 渲染：左栏 */

function renderPool() {
  const lanesBox = $('poolLanes');
  const tabs = [{ code: 'all', name: '全部' }, ...LANES];
  lanesBox.innerHTML = tabs
    .map(
      (t) =>
        `<button data-pool="${t.code}" class="${String(state.poolLane) === String(t.code) ? 'on' : ''}">${t.name}</button>`
    )
    .join('');

  const kw = state.keyword.trim();
  // 按「当前参考段位」的出场率降序 —— 换个段位，英雄池的排序也跟着变
  const list = state.snap.heroes
    .filter((h) => {
      if (state.poolLane !== 'all' && !h.laneCodes.includes(Number(state.poolLane))) return false;
      if (kw && !h.name.includes(kw)) return false;
      return true;
    })
    .sort((a, b) => (globalOf(b.id)?.pickRate || 0) - (globalOf(a.id)?.pickRate || 0));

  $('poolHint').textContent = `${list.length} 个 · 按${modeNameOf(state.modeId)}出场率排`;

  $('heroGrid').innerHTML = list
    .map((h) => {
      const g = globalOf(h.id);
      const tip =
        `${h.name} · ${h.roles}\n` +
        `${modeNameOf(state.modeId)}：胜率 ${pct(g?.winRate)} · 出场 ${pct(g?.pickRate)} · 禁用 ${pct(g?.banRate)}` +
        (state.modeId === 5 ? '' : `\n（分路胜率与协同指数仍为巅峰千强口径）`);
      return `<div class="hero ${state.selected.includes(h.id) ? 'on' : ''}" data-hero="${h.id}" title="${esc(tip)}">
        <img src="${esc(h.avatarUrl)}" alt="" loading="lazy">
        <span>${esc(h.name)}</span>
      </div>`;
    })
    .join('');
}

function renderModeButtons() {
  $('modePick').innerHTML = modeList()
    .map(
      (m) =>
        `<button class="lane ${state.modeId === m.id ? 'on' : ''}" data-mode="${m.id}">${esc(m.name)}</button>`
    )
    .join('');
  $('modeName').textContent = modeNameOf(state.modeId);
}

function renderSelected() {
  const box = $('selChips');
  if (!state.selected.length) {
    box.innerHTML = '<div class="empty">还没选英雄。选中后，推荐会额外计入「与已选英雄同队的协同指数」。</div>';
  } else {
    box.innerHTML = state.selected
      .map((id) => {
        const h = state.heroById.get(id);
        if (!h) return '';
        const laneTxt = h.laneCodes.map((c) => LANE_NAME[c]).join('/');
        return `<span class="chip">
          <img src="${esc(h.avatarUrl)}" alt="">
          ${esc(h.name)}<em>${esc(laneTxt)}</em>
          <button data-unpick="${id}" title="移除">×</button>
        </span>`;
      })
      .join('');
  }
  $('selHint').textContent = state.selected.length
    ? `已选 ${state.selected.length} 个`
    : '可留空（留空则只按分路胜率排）';
}

function renderLaneButtons() {
  $('lanePick').innerHTML = LANES.map(
    (l) => `<button class="lane ${state.lanes.includes(l.code) ? 'on' : ''}" data-lane="${l.code}">${l.name}</button>`
  ).join('');
}

/* ------------------------------------------------------------------ 渲染：结果 */

function renderResults(res) {
  const box = $('results');

  if (!state.lanes.length) {
    box.innerHTML =
      '<div class="notice">先在上面选一个或多个「目标分路」。选中 1 个分路 → 给出该位置的英雄 Top10；' +
      '选中 N 个分路 → 每行是一整套 N 人补位组合的 Top10。</div>';
    return;
  }
  if (!res || !res.top || !res.top.length) {
    box.innerHTML = '<div class="notice err">选中的分路里没有可用候选，换几个分路试试。</div>';
    return;
  }

  const laneTxt = res.lanes.map((c) => LANE_NAME[c]).join(' + ');
  const totalCombos = res.perLane.reduce((a, p) => a * p.poolSize, 1);
  const pairTotal = (res.n * (res.n - 1)) / 2;
  const overCap = state.selected.length + res.n > 5;

  const rows = res.top
    .map((c, i) => {
      const rank = i + 1;
      const members = c.members
        .map(
          (m) => `<div class="mem" title="${esc(m.hero.name)}｜${esc(m.hero.roles)}｜${LANE_NAME[m.laneCode]}
分路胜率 ${pct(m.winRate)}（巅峰千强 · 本路均值 ${pct(m.laneMean)}）· 样本强度 ${m.sample.toFixed(2)}
与已选英雄协同 ${m.synMatches ? (m.synScore >= 0 ? '+' : '') + m.synScore.toFixed(2) + '（' + fmt(m.synMatches) + ' 场共现）' : '无数据（按中性计）'}
本路出场占比 ${pct(m.laneShare)}（英雄自身分布）
${modeNameOf(state.modeId)}全局：胜率 ${pct(globalOf(m.hero.id)?.winRate)} · 出场 ${pct(globalOf(m.hero.id)?.pickRate)}">
            <img src="${esc(m.hero.avatarUrl)}" alt="" loading="lazy">
            <div class="mem-txt">
              <strong>${esc(m.hero.name)}</strong>
              <small>${LANE_NAME[m.laneCode]} ${pct(m.winRate)}</small>${
                state.selected.length
                  ? `<small class="syn-line ${m.synMatches ? 'syn-on' : ''}">${
                      m.synMatches
                        ? `协同 ${m.synScore >= 0 ? '+' : ''}${m.synScore.toFixed(2)} · ${m.synHits} 名已选有共现`
                        : '与已选英雄无共现'
                    }</small>`
                  : ''
              }
            </div>
          </div>`
        )
        .join('<span class="plus">+</span>');

      const pairCls = !c.pairCnt ? 'muted' : c.pairPart >= 50 ? 'up' : 'down';
      // 单分路时每行只有 1 名英雄、不存在组合内对，显示 — 而不是「无数据」（避免看起来像出错）
      const pairTxt = c.pairCnt ? c.pairPart.toFixed(1) : res.n < 2 ? '—' : '无数据';
      const pairSub = res.n < 2 ? '单人组合' : `${c.pairCnt}/${pairTotal} 对有数据`;

      return `<div class="crow">
        <div class="rank ${rank <= 3 ? 'top' : ''}">${rank}</div>
        <div class="col-mem">
          <div class="members">${members}</div>
          <div class="bar"><i style="width:${c.score.toFixed(1)}%"></i></div>
        </div>
        <div class="num score">${c.score.toFixed(1)}</div>
        <div class="num c2">${c.memberAvg.toFixed(1)}<small>成员均分</small></div>
        <div class="num c3 ${pairCls}">${pairTxt}<small>${pairSub}</small></div>
      </div>`;
    })
    .join('');

  const loading = state.pending > 0;
  box.innerHTML =
    (loading
      ? '<div class="loading"><span class="spinner"></span>正在拉取实时协同数据，先用快照结果占位…</div>'
      : '') +
    `<section class="lane-card">
      <div class="lane-head">
        <h3>${res.n === 1 ? '英雄 Top10' : res.n + ' 人补位组合 Top10'}</h3>
        <span class="tag">${esc(laneTxt)}</span>
        <span class="tag muted-tag">分路胜率 · 样本量 · 协同指数 ＝ 巅峰千强</span>
        <span class="stat">候选 ${res.perLane.map((p) => p.poolSize).join(' × ')} ＝ ${fmt(totalCombos)} 组${
          res.pruned ? ` · 为保证响应，各分路只取成员分前 ${res.K} 名参与组合` : ''
        }</span>
      </div>
      <div class="crow head">
        <div>名次</div>
        <div>补位方案</div>
        <div style="text-align:right">组合分</div>
        <div class="c2" style="text-align:right">成员均分</div>
        <div class="c3" style="text-align:right">内部协同</div>
      </div>
      <div class="rows">${rows}</div>
    </section>` +
    (overCap
      ? `<div class="notice err">已选 ${state.selected.length} 个英雄 + 待补 ${res.n} 个位置 = ${
          state.selected.length + res.n
        } 人，超过一队的 5 人。结果只作参考。</div>`
      : '');
}

/* ---------------------------------------------------------------- URL 深链接 */

/** 支持 ?heroes=518,509&lanes=0,1&w=65&p=25&s=30&d=1&gm=5 —— 便于分享固定配置或做静态截图 */
function readURL() {
  const p = new URLSearchParams(location.search);
  // 注意：参数缺失或为空时返回 []，不能让 Number('') === 0 混进来（0 是「对抗路」的合法编码）
  const nums = (key, valid) => {
    const raw = p.get(key);
    if (!raw) return [];
    return raw
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && valid.includes(x));
  };

  const heroIds = nums('heroes', state.snap.heroes.map((h) => h.id));
  state.selected = [...new Set(heroIds)];

  const lanes = nums('lanes', LANES.map((l) => l.code));
  state.lanes = [...new Set(lanes)].sort((a, b) => a - b);

  const num = (key, setter) => {
    const v = Number(p.get(key));
    if (p.get(key) !== null && Number.isFinite(v)) setter(Math.max(0, Math.min(1, v / 100)));
  };
  num('w', (v) => (state.wWin = v));
  num('p', (v) => (state.wPair = v));
  num('s', (v) => (state.shrink = v));
  if (p.get('d') !== null) state.dedup = p.get('d') === '1';

  const gm = Number(p.get('gm'));
  if (p.get('gm') !== null && Number.isFinite(gm) && modeList().some((m) => m.id === gm)) state.modeId = gm;
}

function writeURL() {
  const p = new URLSearchParams();
  if (state.selected.length) p.set('heroes', state.selected.join(','));
  if (state.lanes.length) p.set('lanes', state.lanes.join(','));
  p.set('w', Math.round(state.wWin * 100));
  p.set('p', Math.round(state.wPair * 100));
  p.set('s', Math.round(state.shrink * 100));
  if (state.dedup) p.set('d', '1');
  p.set('gm', String(state.modeId));
  history.replaceState(null, '', '?' + p.toString());
}

/* -------------------------------------------------------------------- 主流程 */

function renderNotice() {
  const meta = state.snap.meta;
  const t = new Date(meta.fetchedAt);
  const ageH = (Date.now() - t.getTime()) / 3600000;
  const stale = ageH > 48;

  const liveTxt =
    state.liveState === 'ok'
      ? '实时协同已接入'
      : state.liveState === 'fail'
        ? '实时接口不可用，已自动回退到快照协同数据'
        : '本次未使用实时接口';

  $('notice').innerHTML = `
    <div class="notice ${stale ? 'err' : ''}">
      数据来源：<a href="${esc(meta.sourceUrl)}" target="_blank" rel="noreferrer">${esc(meta.sourceName)}</a>
      · 数据日期 <b>${esc(meta.dataDate)}</b>
      · 快照抓取于 ${esc(t.toLocaleString('zh-CN'))}
      ${stale ? '（快照已超过 48 小时，建议点击右上角「刷新数据」）' : ''}
      <br>段位口径：<b>分路胜率 · 分路样本量 · 协同指数 = 巅峰千强</b>（站点这些接口不接受段位参数）；
      当前「参考段位 = <b>${esc(modeNameOf(state.modeId))}</b>」只作用于英雄的全局胜率/出场率/禁用率。
      <br>说明：<b>「协同指数」是站点给出的英雄同队配合指数，不是胜率本身</b>；「组合分」是按你设定的权重合成出来的
      <b>排序分，不是预测胜率</b>。 · ${liveTxt}
    </div>`;
  $('foot').innerHTML = `
    数据版权归 ${esc(meta.sourceName)} 所有，本页为其公开接口的本地查询工具，仅供个人参考，请勿商用。<br>
    <b>成员得分</b> = <code>w₁ × 分路胜率得分 + w₂ × 协同指数得分</code>（协同 = 该英雄与你已选英雄的配合）。<br>
    <b>组合分</b> = <code>(1−λ) × 成员均分 + λ × 内部协同得分</code>。选中 N 个分路时，榜单每行是一整套 N 人补位方案，
    「内部协同」算的是<b>这套方案里新选的几名英雄之间</b>的配合，与成员得分里的「和已选英雄的协同」不重复。<br>
    <b>段位口径（务必分清）</b>：分路胜率、分路样本量、协同/克制指数 —— 站点只提供 <b>巅峰千强</b> 口径，
    接口不接受段位参数，页面上的「参考段位」改不了它们；「参考段位」切换的只是英雄的
    <b>全局胜率 / 出场率 / 禁用率</b>，用于英雄池排序与悬浮提示。<br>
    <b>分路胜率得分</b>：以【本路均值】为 50 分、用统一斜率缩放（<code>50 + (收缩后胜率 − 本路均值) × ${WIN_SCALE}</code>），
    所以不同分路的分数可以直接横向比。原始胜率先截断到 [本路均值 ± ${WIN_CLAMP}%]，再按 <code>n/(n+k)</code> 的 1.5 次方向均值收缩。<br>
    <b>分路样本强度 <code>n</code></b> = 该英雄在<b>该分路的对局占比</b>，取站点实测值（同分路全体之和 ≈ 200%，因每局该分路双方各 1 人）。
    <b>不用</b>「全局出场率 × 本路占比」估算 —— 那要求两个接口同口径，实测偏差可达 20 倍以上
    （鲁班大师游走被低估 22 倍、妲己中路被高估 32 倍）。<br>
    <b>协同指数得分</b>：以全站共现分布的 p50 为中性点 50 分、p5 / p95 映射到 0 / 100。
    （实测该指数全为正数、中位数约 2.0，所以「0 即中性」是错的，会把所有候选挤在高分段。）
    无共现数据按中性 50 分计，不奖不罚。<br>
    候选门槛：分路样本强度 <code>n &lt; ${MIN_SAMPLE}</code> 的英雄不进候选（该路基本不打）。<br>
    <b>结果只用于排序参考，不是胜率预测。</b>
  `;
}

async function recompute() {
  state.pending = 1;
  writeURL();
  renderSelected();
  // 先用快照数据秒出结果，避免等待
  renderResults(recommendCombos());

  // 有已选英雄时再拉实时协同指数，拿到后重排
  if (state.selected.length) await ensureLive();

  state.pending = 0;
  renderResults(recommendCombos());
  renderNotice();
  $('modePill').innerHTML =
    '数据源 <b>' + (state.liveState === 'ok' ? '快照 + 实时' : '快照') + '</b>';
}

/* -------------------------------------------------------------------- 事件 */

function bind() {
  document.addEventListener('click', (ev) => {
    const poolBtn = ev.target.closest('[data-pool]');
    if (poolBtn) {
      state.poolLane = poolBtn.dataset.pool === 'all' ? 'all' : Number(poolBtn.dataset.pool);
      renderPool();
      return;
    }

    const hero = ev.target.closest('[data-hero]');
    if (hero) {
      const id = Number(hero.dataset.hero);
      const i = state.selected.indexOf(id);
      if (i >= 0) state.selected.splice(i, 1);
      else state.selected.push(id);
      renderPool();
      recompute();
      return;
    }

    const unpick = ev.target.closest('[data-unpick]');
    if (unpick) {
      const id = Number(unpick.dataset.unpick);
      state.selected = state.selected.filter((x) => x !== id);
      renderPool();
      recompute();
      return;
    }

    const lane = ev.target.closest('[data-lane]');
    if (lane) {
      const code = Number(lane.dataset.lane);
      const i = state.lanes.indexOf(code);
      if (i >= 0) state.lanes.splice(i, 1);
      else state.lanes.push(code);
      state.lanes.sort((a, b) => a - b);
      renderLaneButtons();
      recompute();
      return;
    }

    // 参考段位只切换全局数据的口径，不动排序算法的主指标（分路/协同恒为千强）
    const mode = ev.target.closest('[data-mode]');
    if (mode) {
      state.modeId = Number(mode.dataset.mode);
      renderModeButtons();
      renderPool();
      recompute();
    }
  });

  $('search').addEventListener('input', (ev) => {
    state.keyword = ev.target.value;
    renderPool();
  });

  $('wWin').addEventListener('input', (ev) => {
    state.wWin = Number(ev.target.value) / 100;
    $('wWinLabel').textContent = Math.round(state.wWin * 100) + '%';
    $('wSynLabel').textContent = Math.round((1 - state.wWin) * 100) + '%';
    renderResults(recommendCombos());
  });

  $('wPair').addEventListener('input', (ev) => {
    state.wPair = Number(ev.target.value) / 100;
    $('wPairLabel').textContent = Math.round(state.wPair * 100) + '%';
    $('wPairRestLabel').textContent = Math.round((1 - state.wPair) * 100) + '%';
    renderResults(recommendCombos());
  });

  $('shrink').addEventListener('input', (ev) => {
    state.shrink = Number(ev.target.value) / 100;
    $('shrinkLabel').textContent = Math.round(state.shrink * 100) + '%';
    renderResults(recommendCombos());
  });

  $('dedup').addEventListener('change', (ev) => {
    state.dedup = ev.target.checked;
    writeURL();
    renderResults(recommendCombos());
  });

  $('refreshBtn').addEventListener('click', async () => {
    const btn = $('refreshBtn');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || '刷新失败');
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await (await fetch('/api/refresh/status')).json();
        if (!st.running) {
          if (st.exitCode !== 0) throw new Error(st.error || '抓取脚本失败');
          break;
        }
      }
      await loadSnapshot();
      state.liveKey = null;
      state.liveMap = null;
      state.liveState = 'idle';
      $('dataDate').textContent = state.snap.meta.dataDate;
      $('heroCount').textContent = state.snap.heroes.length;
      if (!modeList().some((m) => m.id === state.modeId)) state.modeId = 5;
      renderModeButtons();
      renderPool();
      await recompute();
      btn.textContent = '已更新';
    } catch (err) {
      alert('刷新失败：' + err.message);
      btn.textContent = '刷新数据';
    } finally {
      btn.disabled = false;
      setTimeout(() => (btn.textContent = '刷新数据'), 2000);
    }
  });
}

async function main() {
  try {
    await loadSnapshot();
  } catch (err) {
    $('notice').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
    return;
  }

  $('dataDate').textContent = state.snap.meta.dataDate;
  $('heroCount').textContent = state.snap.heroes.length;

  readURL();

  $('wWin').value = Math.round(state.wWin * 100);
  $('wPair').value = Math.round(state.wPair * 100);
  $('shrink').value = Math.round(state.shrink * 100);
  $('dedup').checked = state.dedup;
  $('wWinLabel').textContent = Math.round(state.wWin * 100) + '%';
  $('wSynLabel').textContent = Math.round((1 - state.wWin) * 100) + '%';
  $('wPairLabel').textContent = Math.round(state.wPair * 100) + '%';
  $('wPairRestLabel').textContent = Math.round((1 - state.wPair) * 100) + '%';
  $('shrinkLabel').textContent = Math.round(state.shrink * 100) + '%';

  bind();
  renderLaneButtons();
  renderModeButtons();
  renderPool();
  renderSelected();
  renderNotice();
  renderResults(null);

  if (state.lanes.length || state.selected.length) await recompute();
}

main();
