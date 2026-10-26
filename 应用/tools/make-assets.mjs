// make-assets.mjs —— 把 原图/ 里用户提供的两张原图，做成页面真正吃的那两张派生图。
//
// 用法：node 应用/tools/make-assets.mjs [avatar|tail|all|logo]   （默认 all）
// 产出：应用/avatar/a-jing.jpg（340×604）、应用/avatar/whale-tail.png（64×93）
// `all` 只跑这两张——它们能逐字节复现出交付件里那两份。校徽（logo）复现不出来，得显式点名，
// 理由见文件末尾。
//
// 不在构建链上：build.mjs 从不运行本脚本，它只读上面两张产物，所以改完 原图/ 之后
//   ①跑本脚本 ②再跑一次 node 应用/build.mjs —— 少第二步，交付件里还是旧图。
//
// 走 .NET System.Drawing，经 PowerShell -EncodedCommand 调用（本机执行策略是 Restricted，
// 不用也不能用 -ExecutionPolicy Bypass 去绕）。中文路径两边都先搬进纯 ASCII 的临时目录——
// PowerShell 5.1 对中文路径的编码不可靠；产物由 Node 侧的 copyFile 落到中文路径，不经过 PowerShell。
//
// **参数不许顺手改**。这两张图当前的字节就是这么来的，动了参数页面照样能跑，
// 只是产物会跟交付件里那份对不上（逐字节比对的结果记在 tools/README.md）。

import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const SRC_DIR = path.join(ROOT, '原图');

// PowerShell 要能读到路径，临时目录就得是纯 ASCII 的
const TMP = path.join(os.tmpdir(), 'jnu-tools');
if (!/^[\x20-\x7e]+$/.test(TMP)) {
  throw new Error(`临时目录路径含非 ASCII 字符，PowerShell 读不了：${TMP} —— 设一下 TEMP 再跑。`);
}
await mkdir(TMP, { recursive: true });

// 出错时 PowerShell 只会甩一屏看不懂的 CLIXML，连行号都对不上模板里的行号 ——
// 所以每次都把这段 PS 原文落到临时目录，报错时照着 TMP/*.ps 逐字符看。
const ps = (script, dumpName) => {
  if (dumpName) {
    const p = path.join(TMP, dumpName + '.ps');
    writeFileSync(p, script, 'utf8');
  }
  return execFileSync('powershell',
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8' }).trim();
};

async function report(dest, expect) {
  const buf = await readFile(dest);
  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(`  → ${path.relative(ROOT, dest)}  ${Math.round(buf.length / 1024 * 10) / 10} KB  sha256 ${sha.slice(0, 16)}`);
  if (expect && buf.length !== expect.bytes) {
    console.log(`  ⚠ 与 tools/README.md 记的 ${expect.bytes} B 对不上——参数被改过了？`);
  }
}

// —— 立绘：宽 340（高随比例，1052×1870 → 340×604），JPEG q88 ——
// 源图 1052×1870 是竖幅人像，按**宽**缩，不是按长边；长边 604 是 #avatar 的显示高度定的。
async function makeAvatar() {
  const SRC = path.join(SRC_DIR, '角色立绘.png');
  const IN = path.join(TMP, 'avatar-src.png');
  const OUT = path.join(TMP, 'avatar-out.jpg');
  const DEST = path.join(APP, 'avatar', 'a-jing.jpg');
  const W = 340, Q = 88;

  await copyFile(SRC, IN);
  console.log('立绘：' + ps(`
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${IN.replace(/\//g, '\\')}')
$w=${W}; $h=[int][Math]::Round($src.Height*$w/$src.Width)
$bmp=New-Object System.Drawing.Bitmap($w,$h)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src,0,0,$w,$h)
$g.Dispose()
$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}
$ps=New-Object System.Drawing.Imaging.EncoderParameters(1)
$ps.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]${Q})
$bmp.Save('${OUT.replace(/\//g, '\\')}',$enc,$ps)
$c=$bmp.GetPixel(0,0)
Write-Output ("src={0}x{1} -> {2}x{3}  JPEG q${Q}  corner=#{4:X2}{5:X2}{6:X2}" -f $src.Width,$src.Height,$w,$h,$c.R,$c.G,$c.B)
$src.Dispose(); $bmp.Dispose()
`, 'avatar'));
  await copyFile(OUT, DEST);
  await report(DEST, { bytes: 50032 });
}

// —— 鲸尾：从设定表裁 1348,298 178×258 → 宽 64（得 64×93），底色刷纯白，PNG ——
// 阈值 10 是量出来的：底色 30900 个像素全落在「与角点色相差 ≤9」之内，
// 而尾巴的浅色描边还在这之外，所以刷白只吃到底色和它外沿的抗锯齿，吃不掉描边。
// 裁切框避开了右下角的「豆包AI生成」水印（那在 x≈1846 以外）。
const [TX, TY, TW_, TH] = [1348, 298, 178, 258];
const TAIL_W = 64, TOL = 10;

async function makeTail() {
  const SRC = path.join(SRC_DIR, '角色设定表.png');
  const IN = path.join(TMP, 'tail-src.png');
  const OUT = path.join(TMP, 'tail-out.png');
  const DEST = path.join(APP, 'avatar', 'whale-tail.png');

  await copyFile(SRC, IN);
  const log = ps(`
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${IN.replace(/\//g, '\\')}')
$rect=New-Object System.Drawing.Rectangle(${TX},${TY},${TW_},${TH})
$bmp=$src.Clone($rect,$src.PixelFormat)
$bg=$bmp.GetPixel(0,0)
$white=[System.Drawing.Color]::FromArgb(255,255,255)
for($yy=0;$yy -lt ${TH};$yy++){
  for($xx=0;$xx -lt ${TW_};$xx++){
    $c=$bmp.GetPixel($xx,$yy)
    $d=[Math]::Max([Math]::Abs($c.R-$bg.R),[Math]::Max([Math]::Abs($c.G-$bg.G),[Math]::Abs($c.B-$bg.B)))
    if($d -le ${TOL}){ $bmp.SetPixel($xx,$yy,$white) }
  }
}
$tw=${TAIL_W}; $th=[int][Math]::Round(${TH}*$tw/${TW_})
$small=New-Object System.Drawing.Bitmap($tw,$th)
$g=[System.Drawing.Graphics]::FromImage($small)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($bmp,0,0,$tw,$th)
$g.Dispose()
$small.Save('${OUT.replace(/\//g, '\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$c0=$small.GetPixel(0,0)
Write-Output ("crop ${TX},${TY} ${TW_}x${TH} -> {0}x{1}  bg #{2:X2}{3:X2}{4:X2}  corner #{5:X2}{6:X2}{7:X2}" -f $tw,$th,$bg.R,$bg.G,$bg.B,$c0.R,$c0.G,$c0.B)
$src.Dispose();$bmp.Dispose();$small.Dispose()
`, 'tail').split('\n').pop();
  console.log('鲸尾：' + log);
  await copyFile(OUT, DEST);
  await report(DEST, { bytes: 7102 });
}

// —— 校徽：只在这里单独说，**不进 all** ——
// 应用/logo.jpg（192×192，17327 B）比上面两张早两天，是另一个工具编的，原始参数已经找不到：
// PIL 的 6 种重采样 × q88–96 全组合、.NET 的 4 种插值 × 3 种 PixelOffsetMode × 32bpp/24bpp
// × q86–96（528 种）都试过，没有一个逐字节相同——最接近的差 34 B。
// 所以：这个函数是**重制**，不是复现。默认不许它跑——不然谁手一抖 `all` 一下，交付件里的
// 校徽就悄悄换了，而且换完构建照过、页面也看不出来。要重制就显式点名：make-assets.mjs logo
async function makeLogo() {
  const SRC = path.join(ROOT, '暨大史料', '专题-校徽校门校训校歌', 'A28-06-现在的暨南大学校徽.jpg');
  const IN = path.join(TMP, 'logo-src.jpg');
  const OUT = path.join(TMP, 'logo-out.jpg');
  const DEST = path.join(APP, 'logo.jpg');
  const W = 192, Q = 92;

  await copyFile(SRC, IN);
  console.log('校徽（重制）：' + ps(`
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${IN.replace(/\//g, '\\')}')
$bmp=New-Object System.Drawing.Bitmap(${W},${W})
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src,0,0,${W},${W})
$g.Dispose()
$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}
$ep=New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]${Q})
$bmp.Save('${OUT.replace(/\//g, '\\')}',$enc,$ep)
Write-Output ("src {0}x{1} -> ${W}x${W}  JPEG q${Q}" -f $src.Width,$src.Height)
$src.Dispose();$bmp.Dispose()
`, 'logo'));
  await copyFile(OUT, DEST);
  const buf = await readFile(DEST);
  console.log(`  → 应用/logo.jpg  ${buf.length} B（原文件 17327 B，逐字节不同——见 tools/README.md）`);
  console.log('  ⚠ 交付件里的校徽大小会跟着变，记得重跑 node 应用/build.mjs 并目视确认。');
}

// 源图缺了就直说缺哪张，别让 PowerShell 报一句看不懂的
for (const f of ['角色立绘.png', '角色设定表.png']) {
  const p = path.join(SRC_DIR, f);
  try { await stat(p); } catch { throw new Error(`读不到源图：${p}`); }
}

const which = process.argv[2] || 'all';
if (which === 'avatar' || which === 'all') await makeAvatar();
if (which === 'tail' || which === 'all') await makeTail();
if (which === 'logo') await makeLogo();
if (which === 'all') {
  console.log('校徽没跑：它复现不出来（原参数已佚），默认不碰。要重制就显式跑 make-assets.mjs logo。');
}
console.log('完成。记得再跑一次：node 应用/build.mjs —— 否则交付件里还是旧图。');
