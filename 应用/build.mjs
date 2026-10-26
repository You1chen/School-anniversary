// build.mjs —— 把知识库 + 检索算法 + 页面模板，打包成**一个**自包含 HTML。
//
// 用法：node build.mjs
// 产出：交付/暨南校史数字人.html
//
// 设计：数据(知识库/) 与 代码(本目录) 分离，每次改动后跑一遍即可。
//   内置密钥泄漏扫描：只要产物里出现 sk- 形态字符串，直接中止。

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, '知识库');
const OUT = path.join(ROOT, '交付');

// 密钥形态：本项目有两类前缀 —— sk-（DeepSeek 等）与 ark-（火山方舟兜底线路）。
// 扫描前必须把密文剥掉（见第 4 步），否则 base64 里的随机字符会误报成密钥。
const SECRET_RE = /(?:sk|ark)-[A-Za-z0-9_\-]{20,}/;

// —— 1. 读知识库 ——
const manifest = JSON.parse(await readFile(path.join(KB, 'manifest.json'), 'utf8'));
const fallbackRaw = JSON.parse(await readFile(path.join(KB, 'fallback.json'), 'utf8'));

// —— 1a. 人设卡（不是分片：不进 ITEMS、不参与检索打分，理由见该文件的 _说明）——
// 三样缺一不可：没名字，头像下面那行会变成光秃秃的占位符；没口吻，人设形同虚设；
// 没 hard_rules，阿鲸就可能自称是暨大吉祥物——而校徽上画的是帆船。
// 这三种都不会让页面报错，只会静默地什么都不生效。
const persona = JSON.parse(await readFile(path.join(KB, 'persona.json'), 'utf8'));
const PERSONA_FIELDS = [
  ['name', '头像下面那行会变成光秃秃的占位符'],
  ['tone', '人设的口吻一句都不生效'],
  ['hard_rules', '阿鲸就没了「不得自称吉祥物」这类约束'],
];
for (const [k, why] of PERSONA_FIELDS) {
  const v = persona[k];
  if (!(Array.isArray(v) ? v.length : String(v || '').trim())) {
    throw new Error(`打包中止：知识库/persona.json 的 ${k} 为空 —— ${why}。`);
  }
}

const items = [];
for (const s of manifest.shards) {
  const shard = JSON.parse(await readFile(path.join(KB, 'shards', s.file), 'utf8'));
  for (const it of shard.items || []) {
    items.push({
      ...it,
      shard: s.shard,
      shardTitle: s.title,
      status: it.status || 'verified',
    });
  }
}

// —— 1b. 地图历史照片 ——
// photos/ 下的文件名主干 == 该区域的 MP 条目 id，三向同构（几何在模板里、文字在知识库、图在 photos/），
// 因此不需要任何映射表，也就不存在映射表写错的可能。
// 源图为 暨大史料/ 各时期图集，已离线缩到长边 560px、JPEG q70（一次性预处理，不进构建流程）。
const PHOTO_DIR = path.join(__dirname, 'photos');
const photos = {};
let photoBytes = 0;
for (const f of (await readdir(PHOTO_DIR)).sort()) {
  if (!f.endsWith('.jpg')) continue;
  const b = await readFile(path.join(PHOTO_DIR, f));
  photos[f.replace(/\.jpg$/, '')] = 'data:image/jpeg;base64,' + b.toString('base64');
  photoBytes += b.length;
}

// 校友楼（MP-011）在本地史料库里确实没有校舍照片 —— 显式白名单，不偷偷放行
const NO_PHOTO_OK = new Set(['MP-011']);
const lackPhoto = items.filter((i) => i.shard === 'MP' && !photos[i.id] && !NO_PHOTO_OK.has(i.id));
if (lackPhoto.length) {
  throw new Error('打包中止：以下地图区域缺照片 → ' + lackPhoto.map((i) => i.id).join(', '));
}

// 地图区域的显示名（热点浮层标题、侧栏 h3）只此一份，图上不再重复印一遍。
// 少了它页面不会报错，只会在浮层里显示成光秃秃的编号，所以在打包时拦下来。
const lackName = items.filter((i) => i.shard === 'MP' && !String(i.name || '').trim());
if (lackName.length) {
  throw new Error('打包中止：以下地图区域缺 name 字段（浮层与侧栏要用）→ ' + lackName.map((i) => i.id).join(', '));
}

// —— 1c. 地图底图 ——
// 源图为用户提供的 原图/校园地图.jpg（6458×8901，24 MB），已离线缩到宽 2400px、JPEG q70、
// 色度抽样 4:2:0（subsampling=2）存为 应用/map/campus-map.jpg（941 KB）。这一步在
// 应用/tools/make-map.py 里，参数要照它来——少写 subsampling 就重现不出同一个文件。
// 源图既不进交付也不参与构建；构建只读这张派生图，
// 不做任何图像处理——单文件 HTML 里没有、也不该有图像库。
// 热区坐标用的就是源图的像素坐标系（viewBox="0 0 6458 8901"），所以派生图必须**等比**缩放——
// 改了宽高比就会让所有热区错位，这里把宽高比也当一道闸门校一下。
const MAP_W = 6458, MAP_H = 8901;
const mapBytes = await readFile(path.join(__dirname, 'map', 'campus-map.jpg'));
const mapUri = 'data:image/jpeg;base64,' + mapBytes.toString('base64');

// —— 1d. 数字人立绘 ——
// 用户提供的角色原图（原图/角色立绘.png）已离线缩到 340×604、JPEG q88，存为
// 应用/avatar/a-jing.jpg（这一步在 应用/tools/make-assets.mjs 里）。原图既不进交付也不参与构建，
// 跟底图一个规矩：构建只读派生图，
// 不做任何图像处理——单文件 HTML 里没有、也不该有图像库。
// 这里唯一要拦的是体积：单文件交付件的意义在于能直接发出去，被一张头像顶到几 MB 就白做了。
const AVATAR_MAX = 200 * 1024;
const avatarBytes = await readFile(path.join(__dirname, 'avatar', 'a-jing.jpg')).catch(() => {
  throw new Error('打包中止：读不到 应用/avatar/a-jing.jpg（数字人立绘）—— 页面上只会剩下一个破图标。');
});
if (avatarBytes.length > AVATAR_MAX) {
  throw new Error(`打包中止：立绘 ${(avatarBytes.length / 1024).toFixed(0)} KB，超过 ${AVATAR_MAX / 1024} KB —— `
    + '交付件会被这一张图顶大。请按 应用/README.md 里的规格（340×604／JPEG q88）重新导出再打包。');
}
const avatarUri = 'data:image/jpeg;base64,' + avatarBytes.toString('base64');

// —— 1e. 鲸尾（加载气泡左边摆的那只）——
// 从用户提供的 原图/角色设定表.png 里裁出来的局部，已离线刷白底、缩到 64×93 存为
// 应用/avatar/whale-tail.png（约 7 KB）。设定表本身不带透明通道、也不进交付——跟立绘一个规矩。
// 它跟立绘是同一个自拟形象，不是史料照片；裁切框避开了设定表右下角的「豆包AI生成」水印。
const TAIL_MAX = 60 * 1024;
const tailBytes = await readFile(path.join(__dirname, 'avatar', 'whale-tail.png')).catch(() => {
  throw new Error('打包中止：读不到 应用/avatar/whale-tail.png（加载气泡那只鲸尾）—— '
    + '解答时那句「正在查阅校史资料…」左边会空出一块。');
});
if (tailBytes.length > TAIL_MAX) {
  throw new Error(`打包中止：鲸尾图 ${(tailBytes.length / 1024).toFixed(0)} KB，超过 ${TAIL_MAX / 1024} KB。`);
}
const tailUri = 'data:image/png;base64,' + tailBytes.toString('base64');

const data = {
  library: manifest.library,
  shards: manifest.shards.map((s) => ({ shard: s.shard, title: s.title, count: s.count })),
  items,
  photos,
  fallback: {
    text: fallbackRaw.fallback?.no_match?.text || '这个问题我暂时还没学到确切的史料。',
    variants: fallbackRaw.fallback?.no_match?.variants || [],
    hints: fallbackRaw.hints?.suggested_questions || [],
  },
  defaults: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  // 只注入提示词真正用得上的三样；persona.json 里的 why（证据与取舍记录）是给人看的，不进产物
  persona: { name: persona.name, tone: persona.tone, hard_rules: persona.hard_rules },
};

// —— 2. 读模板、检索源码、密码模块、校徽、兜底链密文 ——
let template = await readFile(path.join(__dirname, 'template.html'), 'utf8');
let scoring = await readFile(path.join(__dirname, 'scoring.mjs'), 'utf8');
scoring = scoring.replace(/^export\s+/gm, ''); // 页面内联需要的是普通脚本，不是 ESM

// 密码模块与 scoring 同样处理：一份实现，浏览器与 Node 共用（Node 侧用它自测加解密往返）
let crypto = await readFile(path.join(__dirname, 'crypto-mini.mjs'), 'utf8');
crypto = crypto.replace(/^export\s+/gm, '');

// 内置兜底模型链的密文（明文只走过 stdin、从未落盘；重封见 应用/tools/seal-fallback.mjs）
//
// 这个文件是**可选的**：它含可被解密的服务密钥，所以不进公开仓库（见 .gitignore）。
// 缺了它照样能打包——页面退化为"没有内置线路"，用户自填密钥即可；页面那边 hasModel() 已按此分支。
// 因此这里不抛错，只在日志里说明。
let encLiteral = 'null';
const encPath = path.join(__dirname, 'fallback-models.enc');
if (existsSync(encPath)) {
  const encRaw = (await readFile(encPath, 'utf8')).trim();
  let encObj;
  try { encObj = JSON.parse(encRaw); } catch (e) { throw new Error('fallback-models.enc 不是合法 JSON：' + e.message); }
  if (!encObj.ct || !encObj.salt || !encObj.mac) {
    throw new Error('打包中止：fallback-models.enc 结构不完整（缺 ct/salt/mac）—— 兜底线路会整条失效，且只在用户机器上暴露。');
  }
  encLiteral = JSON.stringify(encObj);
} else {
  console.log('  ⚠ 未找到 fallback-models.enc：本次打包不含内置兜底线路（页面将要求填入自己的密钥）');
}

// 校徽：源图 暨大史料/专题-校徽校门校训校歌/A28-06-现在的暨南大学校徽.jpg
// 已预先缩到 192×192（JPEG q92，约 17 KB）存为 logo.jpg，内联成 data URI 保证单文件自包含。
// 这张的原始编码参数没能留下（它比 tools/ 那套脚本更早），tools/make-logo.* 只能重制、不保证逐字节
// 相同；详见 应用/tools/README.md。校徽本身没有重新着色——标准色仍是「蓝绿色」。
const logoBytes = await readFile(path.join(__dirname, 'logo.jpg'));
const logoUri = 'data:image/jpeg;base64,' + logoBytes.toString('base64');

const toJson = (obj) => JSON.stringify(obj)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

// —— 3. 注入 ——
// 替换串用函数形式：base64 里虽然不会有 $，但模板串一旦将来带上 $& 之类就是隐雷
let html = template
  .replace('/*__SCORING__*/', scoring)
  .replace('/*__CRYPTO__*/', () => crypto)
  .replace('/*__FALLBACK_ENC__*/', () => encLiteral)
  .replace('/*__DATA__*/', toJson(data))
  .replace(/__LOGO__/g, logoUri)
  .replace(/__MAP__/g, () => mapUri)
  .replace(/__AVATAR__/g, () => avatarUri)
  .replace(/__TAIL__/g, () => tailUri)
  .replace(/__PERSONA_NAME__/g, () => persona.name);

// 占位符一个都不能剩。漏掉不会报错，只会在页面上留个痕迹：__AVATAR__ 没换是破图标、
// __MAP__ 没换是空白地图、__TAIL__ 没换是加载气泡左边一块空白、__PERSONA_NAME__ 没换是头像下面印着下划线。
const leftover = [...new Set([...html.matchAll(/__[A-Z][A-Z_]{2,}__/g)].map((m) => m[0]))];
if (leftover.length) throw new Error('打包中止：产物里还有没替换的占位符 → ' + leftover.join(', '));

// —— 3b. 地图三向一致性（几何在模板、文字在知识库、照片在 photos/）——
// 这三样分散在三个地方，最容易出的两种错——"知识库加了区域、模板忘了画"和"see_also 指向不存在的条目"——
// 都不会让页面报错，只会让地图悄悄缺一块、或侧栏按钮点了没反应。所以在打包时直接拦下来。
const mpIds = items.filter((i) => i.shard === 'MP').map((i) => i.id);
const inSvg = new Set([...html.matchAll(/id="mp-r-([A-Za-z0-9-]+)"/g)].map((m) => m[1]));
const noRegion = mpIds.filter((id) => !inSvg.has(id));
const noEntry = [...inSvg].filter((id) => !mpIds.includes(id));
if (noRegion.length || noEntry.length) {
  throw new Error('打包中止：地图区域与 MP 条目不匹配'
    + (noRegion.length ? '（知识库有条目、模板无区域：' + noRegion.join(', ') + '）' : '')
    + (noEntry.length ? '（模板有区域、知识库无条目：' + noEntry.join(', ') + '）' : ''));
}
const allIds = new Set(items.map((i) => i.id));
const badRef = [];
for (const i of items) for (const r of i.see_also || []) if (!allIds.has(r)) badRef.push(i.id + '→' + r);
if (badRef.length) throw new Error('打包中止：see_also 指向不存在的条目 → ' + badRef.join(', '));

// 手写的 <g> 里，事件处理函数传的 id 必须与本组自己的 id 一致。写错一个的后果是"点 A 区域弹出 B 的讲解"，
// 而 verify.mjs 不解析 HTML、内联事件在它的 DOM 桩里一次都不触发，这类错它结构上抓不到，只能在这里拦。
const badHandler = [];
for (const m of html.matchAll(/<g id="mp-r-([A-Za-z0-9-]+)"([^>]*)>/g)) {
  const id = m[1];
  const passed = [...m[2].matchAll(/mp(?:Pick|Hover)\('([A-Za-z0-9-]+)'/g)].map((x) => x[1]);
  if (passed.length !== 2 || passed.some((x) => x !== id)) badHandler.push(`${id}（处理函数传的是 ${passed.join(' / ') || '空'}）`);
}
if (badHandler.length) throw new Error('打包中止：地图区域的 id 与事件处理函数传参不一致 → ' + badHandler.join('；'));

// 选中态的样式必须落到 <g> 上：mpPick 收到的 this 就是 <g>，.mp-r 是它里面的 <rect>。
// 写成 .mp-r.on 时这条选择器永远匹配不上——区域点了没有任何视觉反馈，页面不报错，verify 也看不出来
// （它就是踩这个坑进来的：on 加在 <g> 上、选择器却盯着 <rect>）。
if (!/g\.on[^{}]*\.mp-r\s*\{/.test(html)) {
  throw new Error('打包中止：样式里找不到匹配 <g class="on"> 的选中态选择器（应为 `#mp-svg g.on .mp-r{…}`）——'
    + '现在点了地图区域不会有任何视觉反馈。');
}

// 兜底气泡的样式必须真的挂得上。bubble() 是 `b.className = 'bubble' + (cls ? ' ' + cls : '')`，
// 类名落在**内部的 .bubble** 上，所以选择器得写 `.bot .bubble.fb`；原先写的是 `.bot.fb .bubble`
// （盯着行），永远匹配不上——兜底回答于是长得跟正常回答一模一样，「这句不是从史料里来的」
// 这个提示从头到尾没出现过。跟上面 g.on / .mp-r.on 是同一类错，也一样是页面不报错的。
// 这里不写死成某一种写法，而是照着 bubble() 实际挂在哪来要求，将来重构了也不会误报。
const clsOnBubble = /b\.className\s*=\s*'bubble'\s*\+/.test(html);
const fbSel = clsOnBubble ? /\.bot \.bubble\.fb\s*\{/ : /\.bot\.fb \.bubble\s*\{/;
if (!fbSel.test(html)) {
  throw new Error('打包中止：兜底气泡（fb）的样式选择器，与 bubble() 挂类名的位置对不上 —— '
    + (clsOnBubble ? 'bubble() 把类挂在内部的 .bubble 上，选择器应写成 `.bot .bubble.fb`。'
      : 'bubble() 把类挂在外层的行上，选择器应写成 `.bot.fb .bubble`。')
    + '对不上的后果是兜底回答与正常回答长得一样，那个「不是从史料里答的」的提示从来没出现过。');
}

// .chat 的 min-width:0 同理：它是 main 里 1fr 轨道的网格项，auto 的最小尺寸取内容的最小内容宽度。
// 地图放大会把 #mp-frame 撑到上千像素，卡片跟着顶宽，画布不再是滚动容器，右栏被挤出屏幕——
// 页面上看不出报错，只有真的按一次 ＋ 才发现。
if (!/\.chat\{[^}]*min-width:0/.test(html)) {
  throw new Error('打包中止：.chat 上缺少 min-width:0 —— 地图放大后卡片会被内容顶宽，'
    + '画布不再滚动，地图右栏会被挤出屏幕右侧。');
}

// —— 3c. 底图与热区坐标必须对得上 ——
// 最阴的一类错：有人换了底图（裁了一刀、或换成别的校区图），热区坐标却还按老图算 ——
// 页面不报错，12 个区域全在错的位置上。所以这里校两件事：
// (1) 模板里 SVG 的 viewBox 必须等于热区坐标所依据的源图像素尺寸；
// (2) 派生底图的宽高比必须与源图一致（等比缩放过就没问题，裁过就会露馅）。
const jpegSize = (b) => {
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
};
const vb = html.match(/id="mp-svg"[^>]*viewBox="0 0 (\d+) (\d+)"/) || [];
if (vb[1] !== String(MAP_W) || vb[2] !== String(MAP_H)) {
  throw new Error(`打包中止：地图 viewBox 是 ${vb[1] || '（没找到）'}×${vb[2] || ''}，`
    + `与热区坐标所依据的源图像素 ${MAP_W}×${MAP_H} 不一致 → 12 个热区会整体错位。`);
}
const [mw, mh] = jpegSize(mapBytes);
if (!mw || Math.abs(mw / mh - MAP_W / MAP_H) > 0.002) {
  throw new Error(`打包中止：派生底图 ${mw}×${mh} 的宽高比与源图 ${MAP_W}×${MAP_H} 不符 ——`
    + `底图被裁过或换过，热区坐标就不再对得上。请按源图等比缩放重新导出 应用/map/campus-map.jpg。`);
}

// photos/ 里出现不对应任何 MP 条目的图片：多半是文件名打错了，会白白内联进产物撑大交付件
const strayPhoto = Object.keys(photos).filter((k) => !mpIds.includes(k));
if (strayPhoto.length) throw new Error('打包中止：photos/ 里有不对应任何 MP 条目的图片 → ' + strayPhoto.join(', '));

// —— 3d. 人设不许挤掉防幻觉的硬规则 ——
// 页面上提示词只有一个组装点（sysFor）：人设（口吻）→ GUARD（防幻觉）→ 本次任务。
// 下面几条合起来保证「人设真注进去了」「人设排在硬规则之前」「没有第二条绕开硬规则的路径」。
// 它们一条都不影响页面能否跑起来，只影响它会不会开始编年份 —— 所以只能在这里拦。
const joins = (html.match(/GUARD\.join\(/g) || []).length;
if (joins !== 1) {
  throw new Error(`打包中止：GUARD.join( 在产物里出现 ${joins} 次，应为 1 次 —— 提示词必须有且只有一处组装点，`
    + '多一处就多一条绕开防幻觉规则的调用路径。');
}
if (!/PERSONA_TONE\s*\+\s*GUARD\.join\(/.test(html)) {
  throw new Error('打包中止：人设块没有拼在 GUARD 之前 —— 顺序反了，口吻就可能盖过防幻觉规则。');
}
const lostTone = persona.tone.concat(persona.hard_rules).filter((l) => !html.includes(l));
if (lostTone.length || !html.includes(persona.name)) {
  throw new Error('打包中止：人设卡的内容没有进产物 → '
    + (lostTone.length ? lostTone[0].slice(0, 20) + '…' : persona.name));
}
for (const key of ['你只能依据【候选资料】回答', '不要编造人名、年份、数字、职务']) {
  if (!html.includes(key)) throw new Error(`打包中止：GUARD 里找不到「${key}」—— 防幻觉规则被删或被改写了。`);
}

// —— 3e. 加载气泡那只鲸尾 ——
// 它的底是在预处理那一步刷成纯白的（见 应用/tools/make-assets.mjs），气泡底就必须是同一个白；差一点点，
// 两者相接处会现出一小块比气泡略暖的方块。这类错页面不报错、verify.mjs 也结构上抓不到，
// 只有真的等一次慢网络才看得见。另外「带了 load 类」也要校：忘了加，鲸尾一次都不显示。
if (!/\.load \.bubble\{[^}]*background:#fff\b/.test(html)) {
  throw new Error('打包中止：.load .bubble 的底色不是纯白 —— 鲸尾图刷的底就是纯白，'
    + '底色差一点点，图上就会现出一块偏暖的方块。');
}
if (!/pend\.className\s*=\s*'row bot load'/.test(html)) {
  throw new Error('打包中止：加载气泡没带上 load 类 —— 鲸尾图一次都不会显示，页面也不报错。');
}

// —— 4. 密钥扫描（硬闸门）——
// 先剥掉 data URI 再扫，避免图片数据被当成密钥文本。
// 字符类必须是 [a-z0-9.+-] 而不是 [a-z]+：MIME 子类型里可能带 + 和 .（如 svg+xml、vnd.microsoft.icon），
// 且非 base64 的 data URI（data:image/svg+xml,<svg …>）不带 ;base64,，旧写法一条都剥不掉。
// 终止条件 [^"'\s)>] 对应三种宿主：HTML 属性止于 "、CSS url() 止于 )、JSON/JS 字符串止于 "。
const htmlForScan = html
  .replace(/data:image\/[a-z0-9.+-]+(?:;base64)?,[^"'\s)>]*/gi, '')
  .split(encLiteral).join(''); // 密文本身要剥掉：它是 base64，随机字符可能恰好像密钥
if (SECRET_RE.test(htmlForScan)) {
  const m = htmlForScan.match(SECRET_RE);
  throw new Error('打包中止：产物里出现明文密钥形态字符串 → ' + m[0].slice(0, 12) + '…（密钥应当只以密文形式存在）');
}

// —— 5. 输出 ——
await mkdir(OUT, { recursive: true });
const outFile = path.join(OUT, '暨南校史数字人.html');
await writeFile(outFile, html, 'utf8');

console.log(`已生成：${outFile}`);
console.log(`  ${items.length} 条知识 / ${manifest.shards.length} 个分片`);
console.log(`  大小 ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(0)} KB｜校徽内联 ${(logoBytes.length / 1024).toFixed(1)} KB`);
console.log(`  地图区域 ${mpIds.length} 个｜照片内联 ${Object.keys(photos).length} 张｜${(photoBytes / 1024).toFixed(0)} KB 原始（base64 后约 ${((photoBytes * 4) / 3 / 1024).toFixed(0)} KB）`);
console.log(`  人设：${persona.name}（${persona.tone.length} 条口吻 + ${persona.hard_rules.length} 条硬约束，排在 GUARD 之前）`);
console.log(`  立绘内联 ${(avatarBytes.length / 1024).toFixed(0)} KB（上限 ${AVATAR_MAX / 1024} KB）｜鲸尾 ${(tailBytes.length / 1024).toFixed(1)} KB`);
console.log(`  底图内联 ${mw}×${mh}｜${(mapBytes.length / 1024).toFixed(0)} KB 原始（base64 后约 ${((mapBytes.length * 4) / 3 / 1024).toFixed(0)} KB）`);
console.log(encLiteral === 'null'
  ? '  兜底模型链：未内联（无 fallback-models.enc）'
  : `  兜底模型链：密文内联 ${encLiteral.length} 字符（明文密钥不在产物内）`);
console.log('  密钥扫描：无泄漏 ✓');
