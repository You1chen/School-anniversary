// 校验.mjs —— 「校验并生成审阅稿.ps1」的 Node 版，检查项与输出格式逐条对齐。
//
// 为什么要有这个文件：本机 PowerShell 执行策略为 Restricted，.ps1 一律跑不起来；解除执行策略属于系统
// 安全设置，不该由脚本自行绕过。Node 不受该策略约束，于是把同一套规则再实现一遍。
//
// ⚠ 两者是**一套规则的两种实现**，改校验规则时必须一起改，否则会出现"这个说通过、那个说不过"。
//   生成 审阅稿.md 的抬头文字刻意与 .ps1 保持一致（只写 .ps1 的名字），免得两个工具互相覆盖时
//   多出无意义的差异。唯一的差别是换行符：WriteAllLines 在 Windows 上写 CRLF，本脚本写 LF，
//   因为磁盘上现有的 审阅稿.md 就是 LF（此前 .ps1 在本机从未跑成过），改成 CRLF 只会把整个文件
//   换一遍行尾，白白制造几千行 diff。哪天真跑成 .ps1，一次性换成 CRLF 也无妨。
//
// 用法：
//   node 校验.mjs                 只校验 + 重新生成 审阅稿.md，不改动任何数据
//   node 校验.mjs --sync-manifest  额外把各分片实际条目数写回 manifest.json

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kb = path.dirname(fileURLToPath(import.meta.url));
const shardsDir = path.join(kb, 'shards');
const manifestPath = path.join(kb, 'manifest.json');
const reviewPath = path.join(kb, '审阅稿.md');
const syncManifest = process.argv.includes('--sync-manifest');

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// —— 读取分片（按文件名排序，与 Get-ChildItem | Sort-Object Name 一致）——
const problems = [];
const shards = [];
const all = [];

const files = (await readdir(shardsDir)).filter((f) => f.endsWith('.json')).sort();
for (const name of files) {
  let j;
  try {
    j = JSON.parse(await readFile(path.join(shardsDir, name), 'utf8'));
  } catch (e) {
    problems.push(`JSON 解析失败：${name} —— ${e.message}`);
    continue;
  }
  if (!j.shard) problems.push(`缺 shard 字段：${name}`);
  if (!j.items) { problems.push(`缺 items 数组：${name}`); continue; }
  if (j.shard && !name.startsWith(j.shard + '-')) problems.push(`文件名与 shard 码不一致：${name} / shard=${j.shard}`);

  shards.push({ code: j.shard, title: j.title, file: name, count: j.items.length });
  for (const it of j.items) {
    if (!it.id || !it.question || !it.answer || !it.source) {
      problems.push(`缺必填字段（id/question/answer/source）：${name} / ${it.id}`);
    }
    if (it.status && it.status !== 'verified' && !it.caveat) {
      problems.push(`status=${it.status} 但没有 caveat：${it.id}`);
    }
    all.push({ shard: j.shard, item: it });
  }
}

// —— 校验：ID 唯一（PowerShell 的哈希表/Group-Object 默认不分大小写，这里跟着用 toLowerCase）——
const idCount = new Map();
for (const r of all) {
  const k = String(r.item.id).toLowerCase();
  idCount.set(k, (idCount.get(k) || 0) + 1);
}
const dupIds = [...idCount].filter(([, c]) => c > 1).map(([k]) => k);
if (dupIds.length) problems.push('重复 ID：' + dupIds.join(', '));

// —— 校验：同一问法不指向两条记录 ——
const seen = new Map();
for (const r of all) {
  const qs = [r.item.question, ...(r.item.aliases || [])];
  for (const q of qs) {
    if (q == null || !String(q).trim()) continue;
    const k = String(q).trim().toLowerCase();
    if (seen.has(k)) problems.push(`问法被多条记录占用：「${String(q).trim()}」 ${seen.get(k)} ↔ ${r.item.id}`);
    else seen.set(k, r.item.id);
  }
}
const totalQ = seen.size;

// —— 校验：与 manifest 的计数比对 ——
let manifest = null;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (e) { /* 与 .ps1 的 Test-Path 分支等价：找不到就跳过这一段 */ }
if (manifest) {
  for (const ms of manifest.shards) {
    const real = shards.find((s) => s.code === ms.shard);
    if (!real) { problems.push(`manifest 登记了分片 ${ms.shard}，但 shards 目录下没有对应文件`); continue; }
    if (real.count !== ms.count) problems.push(`计数不符：${ms.shard} manifest=${ms.count} 实际=${real.count}`);
  }
  for (const s of shards) {
    if (!manifest.shards.some((m) => m.shard === s.code)) problems.push(`分片 ${s.code} 已存在但未登记进 manifest.shards`);
  }
}

// —— 输出校验结果 ——
console.log(`分片：${shards.length} 个｜条目：${all.length} 条｜覆盖问法：${totalQ} 种`);
const stCount = new Map();
for (const r of all) {
  const k = r.item.status || '';
  stCount.set(k, (stCount.get(k) || 0) + 1);
}
for (const k of [...stCount.keys()].sort()) console.log(`  status=${k}: ${stCount.get(k)}`);
if (!problems.length) {
  console.log('校验通过：无结构问题、无重复 ID、无问法冲突、计数一致。');
} else {
  console.log(`发现 ${problems.length} 个问题：`);
  problems.forEach((p) => console.log('  - ' + p));
}

// —— 同步 manifest 计数 ——
// 只在计数确实对不上时才写文件：本脚本用 JSON.stringify 写回，格式与 PowerShell 的 ConvertTo-Json
// 不同（冒号后的对齐空格），每次跑都重写会把整个 manifest.json 的排版换一遍。计数本来就对时不动它。
if (syncManifest) {
  if (!manifest) throw new Error('找不到 manifest.json，无法同步计数');
  const changed = manifest.shards.filter((ms) => {
    const real = shards.find((s) => s.code === ms.shard);
    return real && real.count !== ms.count;
  });
  if (!changed.length) {
    console.log('manifest.json 的分片计数本来就是对的，未改动文件。');
  } else {
    for (const ms of changed) ms.count = shards.find((s) => s.code === ms.shard).count;
    manifest.updated = today;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 4), 'utf8');
    console.log(`已把条目数写回 manifest.json（改动了 ${changed.length} 片：${changed.map((m) => m.shard).join(', ')}）`);
  }
}

// —— 生成审阅稿（抬头文字与 .ps1 逐字相同，见文件顶部说明）——
const sorted = [...shards].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
const out = [];
out.push('# 校史问答库 · 审阅稿');
out.push('');
out.push('> 本文件由 `校验并生成审阅稿.ps1` 依据 `shards/*.json` **自动生成**，请勿直接编辑本文件——改数据请改分片 JSON。');
out.push(`> 生成时间：${today}｜分片 ${shards.length} 个｜条目 ${all.length} 条｜覆盖问法 ${totalQ} 种`);
out.push('> 用途：确认问法粒度、答案长度、出处与标注。');
out.push('');
out.push('## 总览');
out.push('');
out.push('| 分片码 | 名称 | 条目 | 文件 |');
out.push('|---|---|---|---|');
for (const s of sorted) out.push(`| ${s.code} | ${s.title} | ${s.count} | \`${s.file}\` |`);
out.push('');
for (const s of sorted) {
  const items = all.filter((r) => r.shard === s.code).map((r) => r.item);
  out.push('---');
  out.push('');
  out.push(`## ${s.code} · ${s.title}（${items.length} 条）`);
  out.push('');
  for (const i of items) {
    // 与 .ps1 的 CJK 区间同一范围（U+4E00–U+9FFF），写成转义形式以免肉眼分不清两个生僻字
    const cjk = (String(i.answer).match(/[一-鿿]/g) || []).length;
    out.push(`### \`${i.id}\` ${i.question}`);
    if (i.aliases && i.aliases.length) out.push('- **同义问法**：' + i.aliases.join('｜'));
    out.push(`- **答案**（${cjk} 字）：${i.answer}`);
    out.push(`- **出处**：${i.source}`);
    const meta = [];
    if (i.status) meta.push(`status=${i.status}`);
    if (i.period) meta.push(`period=${i.period}`);
    if (i.type) meta.push(`type=${i.type}`);
    if (i.keywords && i.keywords.length) meta.push('keywords=' + i.keywords.join('/'));
    if (meta.length) out.push('- **标注**：' + meta.join('｜'));
    if (i.caveat) out.push(`- ⚠ **注意**：${i.caveat}`);
    out.push('');
  }
}
// 与 WriteAllLines 相同：每行后都补一个换行（含最后一行），UTF-8 不带 BOM；换行符用 LF，理由见文件顶部
await writeFile(reviewPath, out.join('\n') + '\n', 'utf8');
console.log(`审阅稿已生成：${reviewPath}`);

process.exit(problems.length ? 1 : 0);
