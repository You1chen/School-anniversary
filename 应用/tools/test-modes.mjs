// test-modes.mjs —— 验证「云端 / 本地 两档切换不互相覆写」。
// 这是用户实际报的 bug：点「本地模型」把已填好的 DeepSeek 地址与模型名顶掉了。
// 做法：在 DOM 桩里真执行页面脚本，模拟「存云端 → 切本地 → 切回云端」，断言云端配置原样还在。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '..', '交付', '暨南校史数字人.html');
const html = await readFile(FILE, 'utf8');

class El {
  constructor(id) { this.id = id; this._html = ''; this.textContent = ''; this.value = ''; this.style = {}; this.children = []; this.classList = { add() {}, remove() {}, contains() { return false; } }; this.disabled = false; this.className = ''; }
  set innerHTML(v) { this._html = String(v); } get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  insertAdjacentHTML() {} addEventListener() {} remove() {} focus() {} querySelector() { return null; }
}
const els = new Map();
globalThis.document = {
  getElementById(id) { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  createElement(t) { return new El('c:' + t); },
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

// 预置：用户之前已经存过一份云端（DeepSeek）配置
const CLOUD = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', key: 'sk-user-cloud-key' };
const store = new Map([['jnu-avatar-settings-v1', JSON.stringify({ ...CLOUD, mode: 'cloud', slots: { cloud: CLOUD, local: null } })]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// fetch 一律失败 → 本地探测探不到，正好验证"探不到时也不能弄丢云端档"
globalThis.fetch = async () => { throw new Error('offline(stub)'); };
globalThis.AbortSignal = { timeout: () => undefined };
globalThis.speechSynthesis = { cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class {};
process.on('unhandledRejection', () => {});

const blocks = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''));
new Function(blocks.join('\n;\n'))();
await new Promise((r) => setTimeout(r, 200));

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const $ = (id) => globalThis.document.getElementById(id);

console.log('初始：已存云端档，打开设置');
$('open-settings').onclick();
check('地址栏显示云端地址', $('s-base').value === CLOUD.baseUrl, $('s-base').value);
check('云端标签高亮', $('m-cloud').className.includes('on'));

console.log('\n点「本地模型」（本机无服务，探测会失败）');
await $('m-local').onclick();
check('已切到本地档', $('m-local').className.includes('on'));
check('地址被换成本地占位', $('s-base').value.startsWith('http://127.0.0.1'), $('s-base').value);

console.log('\n再点回「云端自定义」');
await $('m-cloud').onclick();
check('云端标签重新高亮', $('m-cloud').className.includes('on'));
check('★ 云端地址没被顶掉', $('s-base').value === CLOUD.baseUrl, $('s-base').value);
check('★ 云端模型名没被顶掉', $('s-model').value === CLOUD.model, $('s-model').value);
check('★ 云端密钥没被顶掉', $('s-key').value === CLOUD.key);

console.log('\n本地档也应当被记住（不该因切走而丢）');
await $('m-local').onclick();
check('切回本地档后仍是本地地址', $('s-base').value.startsWith('http://127.0.0.1'), $('s-base').value);

console.log(fail ? `\n❌ ${fail} 项未通过` : '\n✅ 两档互不覆写，来回切换都能还原');
process.exit(fail ? 1 : 0);
