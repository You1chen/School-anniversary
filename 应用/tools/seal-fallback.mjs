// 应用/tools/seal-fallback.mjs —— 把兜底模型链加密成 应用/fallback-models.enc
//
// 用法（明文只走 stdin，不落盘）：
//   $env:JNU_SEAL_PASS = '<口令>'
//   $json | node tools/seal-fallback.mjs
//
// 口令不写在任何文件里：它只在 template.html 里以 XOR 掩码数组存放（本工具会打印该数组）。
// 重封时从 template.html 的 _PK 数组还原口令即可。

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seal } from '../crypto-mini.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const OUT = path.join(APP, 'fallback-models.enc');
const MASK = 0x5b;

const pass = process.env.JNU_SEAL_PASS;
if (!pass) { console.error('缺少口令：请先设 JNU_SEAL_PASS'); process.exit(1); }

// 读 stdin 明文
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
raw = raw.trim();
if (!raw) { console.error('stdin 没有内容'); process.exit(1); }

let plain;
try { plain = JSON.parse(raw); } catch (e) { console.error('stdin 不是合法 JSON：' + e.message); process.exit(1); }

// 结构自检：漏了这些字段，页面只会静默地少一条兜底线路
if (!plain.provider || !plain.provider.baseUrl || !plain.provider.apiKey) { console.error('provider.baseUrl / provider.apiKey 必填'); process.exit(1); }
if (!Array.isArray(plain.chain) || !plain.chain.length) { console.error('chain 必须是非空数组'); process.exit(1); }
for (const [i, c] of plain.chain.entries()) {
  if (!c.label) { console.error(`chain[${i}] 缺 label（状态栏与日志要用）`); process.exit(1); }
  if (!Array.isArray(c.models) || !c.models.length) { console.error(`chain[${i}] 缺 models`); process.exit(1); }
}

const sealed = seal(plain, pass);
await writeFile(OUT, JSON.stringify(sealed), 'utf8');

const masked = [...pass].map((ch) => ch.charCodeAt(0) ^ MASK);
console.log(`已加密写入：${OUT}`);
console.log(`  线路 ${plain.chain.length} 条｜密文 ${sealed.ct.length} 字符`);
console.log(`  明文密钥是否出现在密文里：${JSON.stringify(sealed).includes(plain.provider.apiKey) ? '❌ 出现了' : '否 ✓'}`);
console.log('\n把下面这行贴进 template.html（口令掩码，不是明文）：');
console.log('const _PK = [' + masked.join(',') + '];');
console.log('\n各线路模型（仅显示，用于核对顺序）：');
plain.chain.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}  →  ${c.models.join(' / ')}`));
