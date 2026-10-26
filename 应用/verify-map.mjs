// verify-map.mjs —— 真跑一遍**校园地图面板**的渲染路径。
//
// 为什么不能并进 verify.mjs：verify.mjs 用正则扫 HTML 源文本，**不解析 DOM**，所以写在 SVG 上的
// onmouseover / onclick 在它的桩里一次都不会触发——地图函数在那里只被"定义"、从未被"调用"，
// 绿灯完全不证明地图能用。而那三个块要 join 后一起跑才拿得到主脚本，这个脚本跟着照做。
//
// 这个脚本补上的正是 verify.mjs 结构上够不到的那段：手动调用 mpHover / mpPick / showTab，
// 断言每个区域真能产出浮层文字、侧栏史照、caveat 与「深入」按钮，另加缩放按钮的钳位。
// 它仍然测不了的：热区在底图上盖得准不准、底图本身有没有加载出来——
// **交付前仍须在 Chrome/Edge 里把 12 个区域逐个悬浮、点击一遍。**
//
// 用法：node verify-map.mjs   （需先跑过 build.mjs）

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '交付', '暨南校史数字人.html');
const html = await readFile(FILE, 'utf8');

const blocks = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''));
if (blocks.length < 3) { console.log(`❌ 只找到 ${blocks.length} 个脚本块，产物可能不完整`); process.exit(1); }

// —— 比 verify.mjs 更完整的 DOM 桩：classList 真的记状态 ——
// 注意桩里**没有** clientWidth/clientHeight，这是故意的：地图的量尺寸路径（mpFit）必须做到
// 「量不到就什么都不做」，否则同样这几行代码在 verify.mjs 那个更瘦的桩里会算出 NaN 并写进 style。
class El {
  constructor(id) {
    this.id = id; this._html = ''; this.textContent = ''; this.value = ''; this.style = {}; this._q = null;
    this.classList = { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { return c; }
  insertAdjacentHTML() {}
  addEventListener() {}
  remove() {}
  focus() {}
  querySelector() { return this._q; }
}
const els = new Map();
const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = [];
globalThis.document = {
  getElementById(id) { if (!els.has(id)) { els.set(id, new El(id)); if (!present.has(id)) missing.push(id); } return els.get(id); },
  createElement(t) { return new El('created:' + t); },
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280; globalThis.innerHeight = 800;
globalThis.addEventListener = () => {};
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
globalThis.fetch = async () => { throw new Error('offline(stub)'); };
globalThis.AbortSignal = { timeout: () => undefined };
globalThis.speechSynthesis = { cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class {};

// 三个块 join 后一起执行，再从函数作用域里把地图函数取出来——页面里它们是全局函数，
// 但这里是 new Function，所以只能用 return 带出来。
let api;
try {
  api = new Function(blocks.join('\n;\n') + '\n;return { mpPick, mpHover, mpMove, mpHide, showTab, mpApply, mpFit, mpZoom, mpName, mpIndex, mpGo, MP_BY_ID };')();
} catch (e) {
  console.log('❌ 地图函数未能取出：' + e.message); process.exit(1);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 假装自己是 SVG 里那个 <g id="mp-r-…">。地标名现在取自知识库条目的 name 字段，
// 这里传进去的 label 只是个「故意与 name 不同」的假名字，用来证明页面没用它。
const mkG = (label) => { const g = new El('g'); g._q = { textContent: label }; return g; };
const frameW = () => document.getElementById('mp-frame').style.width;

const fails = [];
const ids = Object.keys(api.MP_BY_ID).sort();
const NO_PHOTO = new Set(['MP-011']);   // 与 build.mjs 的白名单一致：校友楼在史料库里确实没有校舍照片
console.log(`地图区域 ${ids.length} 个｜脚本引用但页面缺失的 id：${missing.length ? missing.join(', ') : '无'}`);

for (const id of ids) {
  const it = api.MP_BY_ID[id];
  const g = mkG('不该被用到的假名字');

  // —— 名称字段：地图面板每一处显示的名字都必须是知识库里的 name ——
  if (!String(it.name || '').trim()) fails.push(`${id} 缺 name 字段，浮层和侧栏会退化成编号`);

  // —— 点击：右侧详情 ——
  api.mpPick(id, g);
  // 选中态加在 <g> 上（样式侧由 build.mjs 校），这里只证明 JS 这一半确实加了
  if (!g.classList.contains('on')) fails.push(`${id} 点过之后 <g> 没有 on 类，图上不会有选中态`);
  const side = document.getElementById('mp-side').innerHTML;
  if (!side.includes('mpIndex()')) fails.push(`${id} 详情面板没有回到地标索引的入口`);
  if (!it.name || !side.includes('>' + esc(it.name) + '<')) fails.push(`${id} 侧栏标题不是知识库里的 name`);
  if (side.includes('不该被用到的假名字')) fails.push(`${id} 侧栏标题从事件参数取名（应只认知识库 name）`);
  if (!side.includes(esc(it.answer))) fails.push(`${id} 侧栏答案与知识库文字不一致`);
  if (!side.includes('深入 · ')) fails.push(`${id} 侧栏没有「深入」按钮`);
  if (it.caveat && !side.includes(esc(it.caveat))) fails.push(`${id} 侧栏漏了 caveat`);
  const hasShot = /data:image\/jpeg;base64,/.test(side);
  if (NO_PHOTO.has(id)) {
    if (hasShot) fails.push(`${id} 本不该有照片，却内联了图片`);
    else if (!side.includes('没有校舍历史照片')) fails.push(`${id} 应显示"无照片"说明`);
  } else if (!hasShot) fails.push(`${id} 侧栏没有史照`);
  for (const r of it.see_also || []) {
    if (!side.includes(`mpDeep('${r}')`)) fails.push(`${id} 的 see_also ${r} 没生成按钮`);
  }

  // —— 悬浮：浮层 ——
  api.mpHover(id, g, { clientX: 500, clientY: 300 });
  const tip = document.getElementById('mp-tip');
  if (tip.style.display !== 'block') fails.push(`${id} 悬浮时浮层没显示`);
  if (!it.name || !tip.innerHTML.includes(esc(it.name))) fails.push(`${id} 浮层没有知识库里的 name`);
  if (tip.innerHTML.length < 40) fails.push(`${id} 浮层没有速览文字`);
  api.mpHide();
  if (tip.style.display !== 'none') fails.push(`${id} 移开后浮层没隐藏`);
}

// —— 侧栏索引：12 处地标都得在里面，且看完一处还回得去 ——
const gx = mkG('x');
api.mpPick('MP-003', gx);
api.mpIndex();
if (gx.classList.contains('on')) fails.push('回到索引后，图上那处的选中态没有取消（右栏是索引、图上还亮着一处）');
const idx = document.getElementById('mp-side').innerHTML;
for (const id of ids) {
  const nm = api.MP_BY_ID[id].name;
  if (!idx.includes('>' + esc(nm) + '<')) fails.push(`地标索引里没有 ${id} 的「${nm}」`);
  if (!idx.includes(`mpGo('${id}')`)) fails.push(`索引里 ${id} 的按钮没接到 mpGo`);
}

// —— 底图：真的内联进来了、而且是完整的一张 ——
const mapImg = (html.match(/id="mp-img"[^>]*src="(data:image\/[a-z0-9.+-]+;base64,[^"]*)"/) || [])[1];
if (!mapImg) fails.push('页面里没有内联的地图底图（#mp-img 的 src 不是 data URI）');
else if (mapImg.length < 200000) fails.push(`内联底图只有 ${Math.round(mapImg.length / 1024)} KB，不像是完整的一张校图`);

// —— 缩放：钳位与「量不到尺寸就不动」——
api.mpApply(99999);
if (frameW() !== '5200px') fails.push(`放大到上限时画框宽度是 ${frameW()}，应为 5200px`);
api.mpApply(1);
if (frameW() !== '260px') fails.push(`缩小到下限时画框宽度是 ${frameW()}，应为 260px`);
api.mpApply(1234);
if (frameW() !== '1234px') fails.push(`mpApply(1234) 后画框宽度是 ${frameW()}`);
if (!String(document.getElementById('mp-scale').textContent).includes('1234')) fails.push('宽度读数没跟着缩放更新');
api.mpZoom(1.3);
if (frameW() !== '1604px') fails.push(`mpZoom(1.3) 后画框宽度是 ${frameW()}，应为 1604px`);
// 桩里没有 clientWidth：mpFit 必须原地不动，不能把 NaN 写进 style
api.mpApply(777);
api.mpFit();
if (frameW() !== '777px') fails.push(`量不到画布尺寸时 mpFit 不该改动宽度，实际变成了 ${frameW()}`);

// 浮层贴光标定位：靠右、靠下时不能溢出视口
api.mpHover('MP-001', mkG('x'), { clientX: 1275, clientY: 795 });
const tip = document.getElementById('mp-tip');
const left = parseFloat(tip.style.left), top = parseFloat(tip.style.top);
if (!(left >= 0 && left + 280 <= 1280)) fails.push(`靠右时浮层溢出视口：left=${tip.style.left}`);
if (!(top >= 0 && top + 96 <= 800)) fails.push(`靠下时浮层溢出视口：top=${tip.style.top}`);

// 三个面板互斥切换（加了地图面板后 classList 逻辑从两两硬编码改成了 showTab）
for (const k of ['qa', 'gen', 'map']) {
  api.showTab(k);
  for (const t of ['qa', 'gen', 'map']) {
    const want = t === k;
    if (document.getElementById('tab-' + t).classList.contains('on') !== want) fails.push(`showTab('${k}') 后 tab-${t} 的状态不对`);
    if (document.getElementById('panel-' + t).classList.contains('on') !== want) fails.push(`showTab('${k}') 后 panel-${t} 的状态不对`);
  }
}

if (missing.length) fails.push(`脚本引用但页面缺失的 id：${missing.join(', ')}`);
console.log('\n--- 结果 ---');
if (fails.length) {
  console.log(`❌ ${fails.length} 个问题：`);
  fails.forEach((f) => console.log('  ' + f));
  process.exit(1);
}
console.log(`✅ ${ids.length} 个区域的悬浮与点击渲染路径全部通过（含浮层贴边定位、三面板互斥切换）`);
console.log('⚠ 仍须人工在浏览器里目视一遍，这四类它结构上一条都测不了：');
console.log('  1) 12 处色块在底图上盖得准不准（这里没有图像，只有字符串）；');
console.log('  2) 按 ＋ 放大后，地图右栏是否仍在原处（画布该滚动而不是把整页顶宽）；');
console.log('  3) 点开某处详情后，窄屏（<880px）下地图有没有被右栏挤成一条缝；');
console.log('  4) 浮层文字与底图上印的地名有没有互相压住。');
