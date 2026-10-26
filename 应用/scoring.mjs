// scoring.mjs —— 检索打分（纯计算，无任何 Node API；浏览器内联与服务端/评测共用同一份）
//
// 全局目标：这是整个项目里**唯一**需要"算法"的地方，其余都是搬运。
// 打分思路（结论都来自前一轮实测）：
//   1. 归一化：去标点 + 同义归并（的时候→时、哪儿→哪里、啥→什么、咋→怎么、搬/迁）
//      —— 不加这层，「抗战的时候学校搬到哪儿了」对不上「抗战时期学校搬到了哪里」。
//   2. 问法相似度：完全一致 > 包含关系 > 0.55*LCS短语 + 0.2*二元组Jaccard + 0.25*关键词命中。
//      LCS 门槛 ≥5 字且覆盖较短一方 ≥45%：只要求 4 字会因共享「暨南大学」这类通用串而误命中。
//   3. 只做"候选召回"，不做"最终判定"——精确判定交给大模型复排（template 里 fused 成一次调用）。

const PUNCT = /[\s\u3000，。、？！；：""''（）《》【】〈〉「」『』·,.\?!;:"'()[\]{}<>~`@#$%^&*_+=|\\/—–-]/g;
const SYNONYMS = [
  [/的时候/g, '时'],
  [/哪儿|哪里儿/g, '哪里'],
  [/啥/g, '什么'],
  [/咋/g, '怎么'],
  [/搬到|搬迁|迁移|播迁/g, '迁'],
];
const TAIL = /[了的呢吗吧呀啊嘛哦噢]/g;

export function normalize(s) {
  let x = String(s ?? '').toLowerCase().replace(PUNCT, '');
  for (const [re, to] of SYNONYMS) x = x.replace(re, to);
  return x.replace(TAIL, '');
}

function bigrams(s) {
  const set = new Set();
  if (s.length <= 1) { if (s) set.add(s); return set; }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

function lcsLen(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    prev = cur;
  }
  return best;
}

function scoreEntry(e, qn) {
  const targets = [e.question, ...(e.aliases || [])].map(normalize);

  if (qn === normalize(e.question)) return 1;
  if (targets.includes(qn)) return 0.98;

  // 包含关系：长句里嵌着已知问法，或反之
  let contain = 0;
  for (const t of targets) {
    if (t.length >= 4 && qn.length >= 4 && (t.includes(qn) || qn.includes(t))) {
      const r = Math.min(t.length, qn.length) / Math.max(t.length, qn.length);
      contain = Math.max(contain, 0.7 + 0.15 * r);
    }
  }

  // LCS 短语 + 二元组 Jaccard
  const qb = bigrams(qn);
  let phrase = 0, jac = 0;
  for (const t of targets) {
    const L = lcsLen(qn, t);
    if (L >= 5) {
      const r1 = L / Math.min(qn.length, t.length);
      const r2 = L / Math.max(qn.length, t.length);
      if (r1 >= 0.45) phrase = Math.max(phrase, 0.7 * r1 + 0.3 * r2);
    }
    jac = Math.max(jac, jaccard(bigrams(t), qb));
  }

  // 关键词命中率
  const kw = (e.keywords || []).map(normalize).filter(Boolean);
  const kwHit = kw.length ? kw.filter((k) => qn.includes(k)).length / kw.length : 0;

  return Math.max(contain, 0.55 * phrase + 0.2 * jac + 0.25 * kwHit);
}

/** 一句话检索：返回 top-K 候选（不在这里做 matched 判定，判定交给上层/大模型） */
export function search(items, question, opts = {}) {
  const topK = opts.topK ?? 8;
  const qn = normalize(question);
  if (!qn) return { qn, scored: [], top: [] };
  const scored = items
    .map((e) => ({ entry: e, score: Number(scoreEntry(e, qn).toFixed(3)) }))
    .sort((a, b) => b.score - a.score);
  return { qn, scored, top: scored.slice(0, topK) };
}

/** 给每条算一个全文指纹（供主题取料），并统计二元组文档频率用于 IDF 加权覆盖 */
export function buildIndex(items) {
  for (const it of items) {
    it._blob = normalize([it.question, ...(it.aliases || []), ...(it.keywords || []), it.answer].join(' '));
    it._blobGrams = bigrams(it._blob);
  }
  const df = new Map();
  for (const it of items) for (const g of it._blobGrams) df.set(g, (df.get(g) || 0) + 1);
  const N = items.length || 1;
  const idf = new Map();
  for (const [g, c] of df) idf.set(g, Math.max(Math.log(N / (c + 0.5)), 0.02));
  return { idf };
}

/** 主题取料（内容生成用）：话题词短、没有问句结构，用 IDF 加权覆盖率 */
export function searchTopic(items, idf, topic, topK = 8) {
  const qn = normalize(topic);
  if (!qn) return [];
  const grams = new Set(bigrams(qn));
  if (!grams.size) return [];
  const scored = items.map((e) => {
    let num = 0, den = 0;
    for (const g of grams) {
      const w = idf.get(g) ?? Math.min(2, Math.log((idf.size || 1) / 0.5));
      den += w;
      if (e._blobGrams.has(g)) num += w;
    }
    const cov = den ? num / den : 0;
    const q = scoreEntry(e, qn);
    return { entry: e, score: Number(Math.max(cov, q).toFixed(3)) };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
