// gate-test.mjs —— 反向测试 build.mjs 的闸门：**故意把东西弄坏，看打包是不是真的中止**，
// 完了恢复原状、再确认还能正常构建。
//
// 用法：node 应用/tools/gate-test.mjs
//
// 为什么要有这个：闸门最容易的失效方式不是"没写"，而是"写了但永远不触发"——要么正则匹配不上，
// 要么拦的是别的东西。正向跑一遍 build.mjs 全绿**证明不了闸门有效**，只有真的弄坏一次才知道。
// 项目里已经有两道闸门是这样被发现的（第 7 道选中态选择器、第 16 道兜底气泡选择器）。
//
// 本脚本会临时改写这些文件，跑完（包括中途出错）一律恢复：
//   知识库/persona.json、应用/template.html、应用/avatar/a-jing.jpg、应用/avatar/whale-tail.png
// 恢复后必须能正常构建，否则本脚本自己退非零。
import { readFile, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const P = path.join(ROOT, '知识库', 'persona.json');
const T = path.join(APP, 'template.html');
const A = path.join(APP, 'avatar', 'a-jing.jpg');
const A_BAK = A + '.bak';
const W = path.join(APP, 'avatar', 'whale-tail.png');
const W_BAK = W + '.bak';

const origP = await readFile(P, 'utf8');
const origT = await readFile(T, 'utf8');
const origA = await readFile(A);
const origW = await readFile(W);
const fake = (patch) => JSON.stringify({ ...JSON.parse(origP), ...patch }, null, 2);

// 模板类用例必须先证明「替换真的改到了东西」——否则 replace 静默不匹配，
// 构建当然照过，看起来就像闸门失灵（第一轮就是这么误判的）。
const edit = (from, to) => {
  const out = origT.replace(from, to);
  if (out === origT) throw new Error(`测试用例没能改到模板：找不到 ${JSON.stringify(from.slice(0, 30))}`);
  return out;
};

const cases = [
  ['人设 tone 清空', () => writeFile(P, fake({ tone: [] })), 'tone 为空'],
  ['人设名字只有空格', () => writeFile(P, fake({ name: '  ' })), 'name 为空'],
  ['人设 hard_rules 清空', () => writeFile(P, fake({ hard_rules: [] })), 'hard_rules 为空'],
  ['人设与 GUARD 顺序反转', () => writeFile(T, edit("PERSONA_TONE + GUARD.join('\\n')", "GUARD.join('\\n') + PERSONA_TONE")), '人设块没有拼在 GUARD 之前'],
  ['绕开组装点另起一处', () => writeFile(T, edit('function sysFor(task)', "const BYPASS = GUARD.join('\\n');\nfunction sysFor(task)")), '应为 1 次'],
  ['删掉一条防幻觉规则', () => writeFile(T, edit("  '不要编造人名、年份、数字、职务。资料里没写年份就不要写年份。',\n", '')), '防幻觉规则被删'],
  ['立绘文件被删', async () => { await rename(A, A_BAK); }, '读不到 应用/avatar/a-jing.jpg'],
  ['立绘超过体积上限', () => writeFile(A, Buffer.alloc(300 * 1024)), '超过 200 KB'],
  ['产物里剩一个占位符', () => writeFile(T, edit('</style>', '/*__BOGUS__*/</style>')), '没替换的占位符'],
  ['鲸尾文件被删', async () => { await rename(W, W_BAK); }, '读不到 应用/avatar/whale-tail.png'],
  ['加载气泡底色改掉', () => writeFile(T, edit('.load .bubble{background:#fff;', '.load .bubble{background:#f1f5f6;')), '不是纯白'],
  ['加载气泡忘了带 load 类', () => writeFile(T, edit("pend.className = 'row bot load'", "pend.className = 'row bot'")), '没带上 load 类'],
  ['兜底气泡选择器挂错元素', () => writeFile(T, edit('.bot .bubble.fb{', '.bot.fb .bubble{')), '对不上'],
];

let bad = 0;
for (const [name, breakIt, expect] of cases) {
  try {
    await breakIt();
    let out = '', code = 0;
    try { await run('node', ['build.mjs'], { cwd: APP }); }
    catch (e) { code = e.code; out = String(e.stderr || '') + String(e.stdout || ''); }
    const hit = out.includes(expect);
    if (code !== 0 && hit) console.log(`✅ ${name} → 打包中止，理由正确`);
    else { bad++; console.log(`❌ ${name} → exit=${code}，期望理由「${expect}」${hit ? '' : '没出现'}：${(out.split('\n').find((l) => l.includes('Error:')) || out.slice(0, 200))}`); }
  } finally {
    await writeFile(P, origP); await writeFile(T, origT); await writeFile(A, origA); await writeFile(W, origW);
    // 两个「文件被删」的用例是改名藏起来的：上面 writeFile 已经把文件重建了，这里再把改名那份盖回去
    // （没有改名记录的用例，rename 会因源文件不存在而抛错，正是 expected 的，忽略即可）
    for (const [bak, live] of [[A_BAK, A], [W_BAK, W]]) { try { await rename(bak, live); } catch {} }
  }
}

// 恢复后必须能正常构建，否则说明上面的恢复没做干净
try { await run('node', ['build.mjs'], { cwd: APP }); console.log('\n✅ 恢复原状后构建正常'); }
catch (e) { bad++; console.log('\n❌ 恢复后构建失败：' + String(e.stderr || '').slice(0, 300)); }

process.exit(bad ? 1 : 0);
