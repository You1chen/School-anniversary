// verify.mjs —— 把打包出来的单文件 HTML 里的脚本**真正执行一遍**，抓运行期错误。
// 这是打包后必须跑的一道关：只检查字符串存在与否，等于没测页面能不能跑。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '交付', '暨南校史数字人.html');
const html = await readFile(FILE, 'utf8');

const blocks = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''));
if (!blocks.length) { console.log('❌ 没有 <script> 块'); process.exit(1); }
console.log(`内联脚本：${blocks.length} 个块`);

// —— 语法检查（进程内编译）——
try { new Function(blocks.join('\n;\n')); console.log('✅ 语法通过'); }
catch (e) { console.log('❌ 语法错误：' + e.message); process.exit(1); }

// —— 最小 DOM 桩 ——
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
const missing = [];
const documentStub = {
  getElementById(id) { if (!els.has(id)) { els.set(id, new El(id)); if (!present.has(id)) missing.push(id); } return els.get(id); },
  createElement(t) { return new El('created:' + t); },
  addEventListener() {},
};
globalThis.document = documentStub;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
globalThis.fetch = async () => { throw new Error('offline(stub)'); };
globalThis.AbortSignal = { timeout: () => undefined };
globalThis.speechSynthesis = { cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class {};

const errors = [];
process.on('unhandledRejection', (e) => errors.push('rejection: ' + (e && e.stack ? e.stack.split('\n')[0] : e)));
process.on('uncaughtException', (e) => errors.push('exception: ' + (e && e.stack ? e.stack.split('\n')[0] : e)));

try { new Function(blocks.join('\n;\n'))(); }
catch (e) { errors.push('exec: ' + e.message); }

await new Promise((r) => setTimeout(r, 300));

const status = els.get('status');
const bootOk = globalThis.__bootOk === true;
const scriptLoaded = globalThis.__scriptLoaded === true;

console.log('\n--- 结果 ---');
console.log(`主脚本加载哨兵：${scriptLoaded ? '✓' : '✗'}`);
console.log(`启动完成哨兵：${bootOk ? '✓' : '✗'}`);
console.log(`状态标签文字：「${status ? status.textContent : '(null)'}」`);
console.log(`知识库信息：「${els.get('lib-info')?.textContent ?? '(null)'}」`);
if (missing.length) console.log(`脚本引用但页面缺失的 id：${missing.join(', ')}`);

const fail = !scriptLoaded || !bootOk || errors.length || missing.length;
if (fail) {
  console.log('\n❌ 未通过：');
  if (errors.length) errors.forEach((e) => console.log('  ' + e));
  process.exit(1);
}
console.log('\n✅ 页面脚本完整执行，启动正常，无运行期错误');

/* ==========================================================================
   兜底模型链：用**产物里内联的密码模块**解开**产物里内联的密文**
   —— 这段测试只从交付件里取料（密文、算法、口令掩码），不 import 工程源码，
   所以它证明的是"发出去的这个文件自己能解开"，而不是"源码能解开"。
   刻意不给页面加任何调试后门：否则任何人开 F12 就能读到线路里的密钥。
   ========================================================================== */
console.log('\n=== 内置兜底模型链（只从交付件取料）===');

const cryptoSrc = html.match(/\/\/ crypto-mini\.mjs[\s\S]*?(?=\/\* ===== 构建时注入)/);
const encLit = html.match(/const FALLBACK_ENC = (\{.*?\});/);
const pkLit = html.match(/const _PK = (\[[^\]]*\]);/);
if (!cryptoSrc || !encLit || !pkLit) {
  console.log('❌ 交付件里找不到 密码模块 / 密文 / 口令掩码');
  process.exit(1);
}

const { open } = new Function(cryptoSrc[0] + '\nreturn { open };')();
const sealed = JSON.parse(encLit[1]);
const pass = JSON.parse(pkLit[1]).map((c) => String.fromCharCode(c ^ 0x5b)).join('');

let chain;
try { chain = open(sealed, pass); }
catch (e) { console.log('❌ 交付件无法解开自带密文：' + e.message); process.exit(1); }

const routes = chain.chain || [];
console.log(`✅ 交付件自解密成功：${routes.length} 条线路（口令 ${pass.length} 字符，未以明文出现在文件里）`);
routes.forEach((r, i) => console.log(`   ${i + 1}. ${r.label}  →  ${(r.models || []).join(' / ')}`));

// 逐项核对：明文密钥绝不能出现在产物里
const keyPlain = chain.provider.apiKey;
const keyLeak = html.includes(keyPlain);
console.log(keyLeak ? '❌ 明文密钥出现在交付件里！' : '✅ 交付件里搜不到明文密钥');
if (keyLeak) process.exit(1);

// 线路结构完整性：缺字段的线路在页面上只会"静默少一条"，所以在这里拦
const badRoute = routes.filter((r) => !r.label || !(r.models || []).length || !(r.baseUrl || chain.provider.baseUrl));
if (badRoute.length) { console.log('❌ 有线路缺 label/models/baseUrl'); process.exit(1); }
console.log(`✅ 线路字段完整｜provider: ${chain.provider.baseUrl}`);

// 顺序必须与用户指定的一致（顺序错了不会报错，只会静默换掉首选模型）
const order = routes.map((r) => r.label).join(' → ');
console.log(`   顺序：${order}`);

