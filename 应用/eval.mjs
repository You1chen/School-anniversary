// eval.mjs —— 用留出评测集（与库内问法零重复）量检索的离线召回/精度。
// 用法：node eval.mjs

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, buildIndex } from './scoring.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, '知识库');
const SET = path.join(__dirname, 'eval-set');

// 载入知识库
const manifest = JSON.parse(await readFile(path.join(KB, 'manifest.json'), 'utf8'));
const items = [];
for (const s of manifest.shards) {
  const shard = JSON.parse(await readFile(path.join(KB, 'shards', s.file), 'utf8'));
  for (const it of shard.items || []) items.push({ ...it, shard: s.shard, shardTitle: s.title, status: it.status || 'verified' });
}
buildIndex(items);

// 载入评测集
const files = (await readdir(SET)).filter((f) => f.endsWith('.json'));
const cases = [];
for (const f of files) for (const c of JSON.parse(await readFile(path.join(SET, f), 'utf8'))) cases.push({ ...c, _f: f });
const shouldHit = cases.filter((c) => c.expect);
const shouldMiss = cases.filter((c) => !c.expect);

const THRESHOLD = 0.34;
let hitOk = 0, hitWrong = 0, missed = 0, fp = 0, fbOk = 0;
const detail = { missed: [], hitWrong: [], fp: [] };

for (const c of cases) {
  const { top } = search(items, c.q, { topK: 8 });
  const best = top[0];
  const matched = best && best.score >= THRESHOLD;
  const got = matched ? best.entry.id : null;
  if (c.expect) {
    if (got === c.expect) hitOk++;
    else if (got) { hitWrong++; detail.hitWrong.push({ q: c.q, want: c.expect, got, s: best.score }); }
    else { missed++; detail.missed.push({ q: c.q, want: c.expect, s: best ? best.score : 0 }); }
  } else {
    if (got) { fp++; detail.fp.push({ q: c.q, got, s: best.score }); }
    else fbOk++;
  }
}

const pct = (x) => (x * 100).toFixed(1) + '%';
console.log(`知识库 ${items.length} 条 / ${manifest.shards.length} 分片｜评测集 ${cases.length} 条（${files.length} 个文件）`);
console.log(`应命中 ${shouldHit.length}｜应兜底 ${shouldMiss.length}｜阈值 ${THRESHOLD}\n`);
console.log(`召回率（该命中的答对）    ${pct(hitOk / shouldHit.length)}  ${hitOk}/${shouldHit.length}`);
console.log(`命中准确率（命中里答对）  ${pct(hitOk / (hitOk + hitWrong))}  ${hitOk}/${hitOk + hitWrong}`);
console.log(`兜底正确率（该兜底兜住）  ${pct(fbOk / shouldMiss.length)}  ${fbOk}/${shouldMiss.length}`);
console.log(`总体正确率                ${pct((hitOk + fbOk) / cases.length)}  ${hitOk + fbOk}/${cases.length}`);
console.log(`\n漏命中 ${missed}｜命中错条目 ${hitWrong}｜误命中 ${fp}`);

if (detail.missed.length) { console.log('\n-- 漏命中样例 --'); detail.missed.slice(0, 8).forEach((x) => console.log(`  [${x.s}] ${x.want}｜${x.q}`)); }
if (detail.fp.length) { console.log('\n-- 误命中（库外硬答）--'); detail.fp.forEach((x) => console.log(`  [${x.s}] → ${x.got}｜${x.q}`)); }
