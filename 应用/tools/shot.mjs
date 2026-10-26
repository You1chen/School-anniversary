// shot.mjs —— 用 Edge 无头模式把交付件真渲染出来截图，补 README 里说的「交付前须目视」那一步。
//
// 用法：node 应用/tools/shot.mjs <场景名> ["注入的 JS"] [宽] [高]
//   例：node 应用/tools/shot.mjs map            → 截一张默认尺寸的地图面板
//       node 应用/tools/shot.mjs pick "mpPick('MP-005')" 1440 900
//
// 做法：把交付 HTML **复制一份**到临时目录，在 </body> 前插一小段脚本驱动它（比如替你把某个
// 地标点开），再截图。交付件本身一个字节都不动——这点跟 verify-map.mjs 不同，那个是拿 DOM 桩
// 跑逻辑，看不到"两个色块是不是压在同一个地名上"这种只有像素能回答的问题。
//
// 截图落在临时目录（不在项目里，免得生成物混进仓库），跑完会打印路径。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, '交付', '暨南校史数字人.html');
const OUT = path.join(os.tmpdir(), 'jnu-shots');

const scen = process.argv[2] || 'map';
const drive = process.argv[3] || '';
const W = Number(process.argv[4] || 1440), H = Number(process.argv[5] || 900);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) throw new Error('没找到 Edge。装一个，或把本文件里 EDGE 的路径改成 Chrome 的。');

let html = await readFile(SRC, 'utf8');
// 自动应答「模型设置」弹窗：没配密钥时首次打开会弹，挡住画面
html = html.replace('<body>', '<body><script>try{localStorage.setItem("jnu-modal-dismissed","1");}catch(e){}</script>')
  .replace('</body>',
    '<script>window.addEventListener("load",function(){setTimeout(function(){try{' + drive + '}catch(e){document.title="ERR:"+e.message;}},150);});</script></body>');
await mkdir(OUT, { recursive: true });
const tmp = path.join(OUT, 'shot-' + scen + '.html');
await writeFile(tmp, html, 'utf8');

execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--virtual-time-budget=6000', '--window-size=' + W + ',' + H,
  '--screenshot=' + path.join(OUT, scen + '.png'), 'file:///' + tmp.replace(/\\/g, '/')], { stdio: 'inherit' });
console.log('->', path.join(OUT, scen + '.png'));
