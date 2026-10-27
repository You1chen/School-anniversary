// 分块并发下载器（支持断点续传）—— 应对 CDN 单连接限速 + 网络/睡眠中断。
// 用法：node tools/dl-multi.mjs <url> <输出路径> [并发=10] [分块MB=4]
//
// 关键设计（上一版踩过的坑）：
//   1) 失败**不删**已下内容 —— 1 GB 下到 95% 挂掉就全丢，代价太大；
//   2) 用 .parts.json 记录已完成分块，重跑时自动跳过 —— 断网/睡眠后一条命令接着下；
//   3) 数据写在 <out>.part，全部完成才改名 —— 避免把半截文件当成品用。

import { open, stat, rename, unlink, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [url, out, concArg, chunkArg] = process.argv.slice(2);
if (!url || !out) { console.error('用法: node dl-multi.mjs <url> <out> [并发=10] [分块MB=4]'); process.exit(1); }

const CONC = Number(concArg || 10);
const CHUNK = Number(chunkArg || 4) * 1024 * 1024;
const UA = { 'User-Agent': 'Mozilla/5.0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PART = out + '.part';
const META = out + '.parts.json';

await mkdir(path.dirname(out), { recursive: true });

// 已存在成品直接跳过
try { const s = await stat(out); console.log(`已存在，跳过：${out}（${(s.size / 1048576).toFixed(1)} MB）`); process.exit(0); } catch {}

// —— 1. 探总大小 ——
const probe = await fetch(url, { headers: { ...UA, Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
let total = 0, rangeOk = false;
if (probe.status === 206) {
  const m = (probe.headers.get('content-range') || '').match(/\/(\d+)$/);
  if (m) { total = Number(m[1]); rangeOk = true; }
} else if (probe.ok) {
  total = Number(probe.headers.get('content-length') || 0);
}
if (!total) { console.error('拿不到文件大小'); process.exit(1); }

if (!rangeOk) {
  console.log('服务端不支持 Range → 单连接下载');
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(3600000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const fh = await open(PART, 'w'); await fh.write(buf, 0, buf.length, 0); await fh.close();
  await rename(PART, out);
  console.log(`完成：${(buf.length / 1048576).toFixed(1)} MB`);
  process.exit(0);
}

// —— 2. 分块表 ——
const ranges = [];
for (let off = 0; off < total; off += CHUNK) ranges.push([off, Math.min(off + CHUNK, total) - 1]);

// —— 3. 读续传记录 ——
let done = new Set();
try {
  const meta = JSON.parse(await readFile(META, 'utf8'));
  if (meta.total === total) done = new Set(meta.done || []);
} catch {}

// 校验 .part 与记录是否对得上
let partOk = false;
try { partOk = (await stat(PART)).size === total; } catch {}
if (!partOk) { done.clear(); }

let doneBytes = [...done].reduce((a, i) => a + (ranges[i][1] - ranges[i][0] + 1), 0);
console.log(`总 ${(total / 1048576).toFixed(1)} MB｜${ranges.length} 块｜已完成 ${done.size}/${ranges.length}（${(doneBytes / 1048576).toFixed(1)} MB）｜并发 ${CONC}`);
if (done.size) console.log('  ↑ 从断点继续');

// 打开 .part：
//   首次（无有效 .part）→ 'w' 会清空并创建，不必再调 ftruncate
//   续传（.part 已是完整长度）→ 'r+' 保留内容
// 刻意不调用 fh.truncate()：在本机对 D 盘的 .part 调 ftruncate 会 EPERM，
// 而按偏移写入本身就会把文件撑到所需长度（最后一块的末端正好是 total-1），结果一致。
const fh = await open(PART, partOk ? 'r+' : 'w');

const queue = ranges.map((r, i) => i).filter((i) => !done.has(i));
let cursor = 0, failed = 0;
const t0 = Date.now();
const startBytes = doneBytes;
let lastReport = 0;
const saveMeta = () => writeFile(META, JSON.stringify({ total, done: [...done] }), 'utf8');

async function fetchChunk(idx) {
  const [start, end] = ranges[idx];
  const need = end - start + 1;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { ...UA, Range: `bytes=${start}-${end}` },
        redirect: 'follow',
        signal: AbortSignal.timeout(120000),
      });
      if (r.status === 429 || r.status === 503) { await sleep(1200 * attempt); continue; }
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== need) throw new Error(`长度不符 ${buf.length}/${need}`);
      await fh.write(buf, 0, buf.length, start);
      done.add(idx);
      doneBytes += buf.length;
      return;
    } catch (e) {
      if (attempt === 6) { failed++; console.error(`  块 ${idx} (${start}-${end}) 失败: ${e.message}`); return; }
      await sleep(600 * attempt);
    }
  }
}

async function worker() {
  while (cursor < queue.length) {
    const idx = queue[cursor++];
    await fetchChunk(idx);
    // 每完成若干块存一次进度
    if (done.size % 5 === 0) await saveMeta().catch(() => {});
    const pct = Math.floor((doneBytes / total) * 100);
    if (pct >= lastReport + 10) {
      lastReport = pct;
      const sec = (Date.now() - t0) / 1000;
      const spd = (doneBytes - startBytes) / 1048576 / Math.max(sec, 1);
      console.log(`  ${pct}%  ${(doneBytes / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB  ${spd.toFixed(2)} MB/s`);
    }
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
await saveMeta().catch(() => {});
await fh.close();

if (failed) {
  console.error(`\n${failed} 个块仍失败。进度已保存，重跑同一命令即可续传。`);
  process.exit(1);
}

if (done.size !== ranges.length) { console.error('仍有块未完成，重跑续传'); process.exit(1); }

await rename(PART, out);
await unlink(META).catch(() => {});
const sz = (await stat(out)).size;
console.log(`\n完成：${(sz / 1048576).toFixed(1)} MB → ${out}`);
