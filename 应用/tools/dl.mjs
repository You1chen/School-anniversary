// 下载器：流式写入文件，带进度。用法：
//   node tools/dl.mjs <url> <输出路径> [期望大小MB]
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const [url, out, expectMB] = process.argv.slice(2);
if (!url || !out) { console.error('用法: node dl.mjs <url> <out> [期望MB]'); process.exit(1); }

await mkdir(path.dirname(out), { recursive: true });

const t0 = Date.now();
const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0' },
  redirect: 'follow',
  signal: AbortSignal.timeout(60 * 60 * 1000),
});
if (!res.ok) { console.error(`HTTP ${res.status} ${url}`); process.exit(1); }

const total = Number(res.headers.get('content-length') || 0);
console.log(`开始下载：${(total / 1048576).toFixed(0)} MB → ${out}`);
console.log(`实际 URL：${res.url.slice(0, 100)}`);

const ws = createWriteStream(out);
const reader = res.body.getReader();
let got = 0, lastPct = -1;

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= lastPct + 10) {
      lastPct = pct;
      const mb = (got / 1048576).toFixed(0);
      const sec = (Date.now() - t0) / 1000;
      const speed = (got / 1048576 / sec).toFixed(1);
      console.log(`  ${pct}%  ${mb} MB  ${speed} MB/s`);
    }
  }
} catch (e) {
  ws.destroy(); await unlink(out).catch(() => {});
  console.error('下载中断：' + e.message);
  process.exit(1);
}

await new Promise((r) => ws.end(r));

const sz = (await stat(out)).size;
const sec = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`完成：${(sz / 1048576).toFixed(1)} MB，用时 ${sec}s`);

if (expectMB && Math.abs(sz / 1048576 - Number(expectMB)) > Number(expectMB) * 0.15) {
  console.error(`⚠ 大小与期望 ${expectMB} MB 相差较大，可能是错误页面`);
  process.exit(2);
}
