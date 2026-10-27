// test-live.mjs —— 联网实测：直接驱动交付件**自己的代码**走一遍问答，验证兜底链路真的能落到可用模型。
//
// 与 verify.mjs 的分工：那边用离线 fetch 只验"页面能不能跑起来"；这边用真实 fetch 验"模型能不能答上"。
// 会消耗兜底线路的额度，所以不放进构建流程，手动跑：
//   node test-live.mjs              # 正常路径：第一条线路应答
//   node test-live.mjs --failover   # 故障转移：先把首选线路标记为停用，看它是否依次试后面的，最终弹窗
//
// DOM 桩与 verify.mjs 同一套（两处刻意各自持有一份：一个跑离线、一个跑联网，
// 合起来会让"离线测试意外发出真实请求"变成可能）。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '交付', '暨南校史数字人.html');
const html = await readFile(FILE, 'utf8');
const FAILOVER = process.argv.includes('--failover');

class El {
  constructor(id) { this.id = id; this._html = ''; this.textContent = ''; this.value = ''; this.style = {}; this.files = null; this.children = []; this.classList = { add() {}, remove() {}, contains() { return false; } }; this.disabled = false; }
  set innerHTML(v) { this._html = String(v); } get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  insertAdjacentHTML() {}
  addEventListener() {}
  remove() {}
  focus() {}
  querySelector() { return null; }
}
const els = new Map();
const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
globalThis.document = {
  getElementById(id) { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  createElement(t) { return new El('created:' + t); },
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
const store = new Map();
// LOCAL=1：把页面指向本机 llama-server，验证「交付件 + 本地模型」这条路真的通
if (process.env.LOCAL) {
  store.set('jnu-avatar-settings-v1', JSON.stringify({
    baseUrl: process.env.LOCAL_BASE || 'http://127.0.0.1:8080/v1',
    model: process.env.LOCAL_MODEL || 'local',
    key: 'local',
  }));
}
// 故障转移测试：预先把首选线路写进停用名单，看它是否跳过并继续往后试
if (FAILOVER) {
  store.set('jnu-route-dead-v1', JSON.stringify({
    'R:fallback|https://ark.cn-beijing.volces.com/api/v3|doubao-seed-2-1-lite-260915': 1,
  }));
}
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.AbortSignal = { timeout: () => undefined };
globalThis.speechSynthesis = { cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class {};
globalThis.fetch = fetch; // ← 真实网络

const blocks = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''));
const errors = [];
process.on('unhandledRejection', (e) => errors.push('rejection: ' + (e && e.message ? e.message : e)));

console.log(FAILOVER ? '=== 联网实测：故障转移路径 ===' : '=== 联网实测：正常路径 ===');
new Function(blocks.join('\n;\n'))();
await new Promise((r) => setTimeout(r, 1500)); // 等 boot（含解密密文）
console.log(`启动哨兵：${globalThis.__bootOk ? '✓' : '✗'}｜状态：${els.get('status')?.textContent}`);

// 触发一次真实问答（走页面自己的 ask()）
const q = '暨南大学是什么时候创办的？';
globalThis.document.getElementById('q').value = q; // 页面只在提交时才访问 #q，这里按需创建
const form = els.get('f');
if (!form || typeof form.onsubmit !== 'function') { console.log('❌ 拿不到表单提交处理器'); process.exit(1); }
els.get('log').children.length = 0;
form.onsubmit({ preventDefault() {} });

// 等答案落进日志
const t0 = Date.now();
let answered = null;
while (Date.now() - t0 < 120000) {
  await new Promise((r) => setTimeout(r, 500));
  const rows = els.get('log').children.filter((c) => String(c.className || '').includes('bot'));
  const last = rows[rows.length - 1];
  if (last && last.children.length) {
    const txt = last.children[0]._html || '';
    if (txt && !txt.includes('正在查阅校史资料')) { answered = { html: txt, cls: last.className }; break; }
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (!answered) {
  console.log(`❌ ${secs}s 内没有拿到回答`);
  if (errors.length) errors.forEach((e) => console.log('  ' + e));
  process.exit(1);
}

const text = answered.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
console.log(`\n耗时 ${secs}s｜气泡类名 ${answered.cls}`);
console.log(`回答：${text.slice(0, 220)}`);

const st = els.get('s-state');
console.log(`设置弹窗状态：${st ? st._html.replace(/<[^>]+>/g, '') || st.textContent : '(未打开)'}`);
console.log(`状态栏：${els.get('status')?.textContent}｜title=${els.get('status')?.title}`);

const dead = JSON.parse(store.get('jnu-route-dead-v1') || '{}');
const deadKeys = Object.keys(dead).filter((k) => k.startsWith('R:'));
console.log(`已停用线路：${deadKeys.length ? deadKeys.map((k) => k.split('|').pop()).join(', ') : '（无）'}`);

if (FAILOVER) {
  // 全部线路用尽时的**正确表现**是三件事，而不是"没学到"那句兜底话术：
  //   状态栏转「离线」、弹窗要求填自己的服务、回答降级为知识库参考答（检索命中了就用参考答，没命中才用兜底话术）。
  const pillOffline = els.get('status')?.textContent === '离线';
  const modalShown = ((els.get('s-state')?._html) || '').includes('你自己的模型服务');
  const allDead = deadKeys.length === 8;
  const degraded = answered.html.includes('知识库参考答');
  console.log(`\n${deadKeys.length >= 1 ? '✅' : '❌'} 首选线路被跳过，失败线路记入停用名单（${deadKeys.length} 条）`);
  console.log(`${allDead ? '✅' : '❌'} 8 条线路全部停用`);
  console.log(`${pillOffline ? '✅' : '❌'} 状态栏转为「离线」`);
  console.log(`${modalShown ? '✅' : '❌'} 弹窗要求填入自己的模型服务`);
  console.log(`${degraded ? '✅' : '❌'} 回答降级为知识库参考答（不是空白或报错）`);
  process.exit(deadKeys.length >= 1 && allDead && pillOffline && modalShown && degraded ? 0 : 1);
} else {
  const ok = text.includes('1906');
  console.log(`\n${ok ? '✅' : '❌'} 兜底线路真实作答（${ok ? '答案含 1906' : '答案里没有 1906'}）`);
  process.exit(ok ? 0 : 1);
}
