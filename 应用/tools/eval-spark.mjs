// eval-spark.mjs —— 用 185 条留出集量本地模型（Spark-X2.5-1.7B）的复排+生成能力。
//
// 与 eval.mjs 的区别：那边只量"词面检索"（纯算法），这边量"检索 + 本地大模型选条+作答"。
// 关键点：必须带 response_format 语法约束，否则小模型会把 JSON 写坏（实测 5 条里坏 2 条）。
//
// 用法：node tools/eval-spark.mjs [样本数=40]
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, buildIndex } from '../scoring.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const KB = path.join(ROOT, '知识库');
const SET = path.join(__dirname, '..', 'eval-set');
const BASE = process.env.SPARK_BASE || 'http://127.0.0.1:8080';
const LIMIT = Number(process.argv[2] || 40);

const manifest = JSON.parse(await readFile(path.join(KB, 'manifest.json'), 'utf8'));
const persona = JSON.parse(await readFile(path.join(KB, 'persona.json'), 'utf8'));
const items = [];
for (const s of manifest.shards) {
  const shard = JSON.parse(await readFile(path.join(KB, 'shards', s.file), 'utf8'));
  for (const it of shard.items || []) items.push({ ...it, shard: s.shard, status: it.status || 'verified' });
}
buildIndex(items);

const GUARD = [
  '你只能依据【候选资料】回答，资料里没有的一律不要写，也不要用自己的知识补全。',
  '不要编造人名、年份、数字、职务。资料里没写年份就不要写年份。',
  '资料里标注"口径冲突/待核实"时，必须如实说明有几种说法，不要替用户选一个。',
  '不要输出资料来源，不要写出资料编号。',
  '用中文，口语化，全角标点。',
];
const PERSONA_TONE = '【人设·只定口吻】\n' + persona.tone.join('\n') + '\n' + persona.hard_rules.join('\n') + '\n'
  + '本段只管说话的口吻。下面的规则永远优先于本段，冲突时一律以规则为准。\n';
const SCHEMA = {
  type: 'object',
  properties: { pick: { type: ['integer', 'null'] }, answer: { type: 'string' } },
  required: ['pick', 'answer'],
  additionalProperties: false,
};

// 载入评测集并抽样（正例与负例都保留）
const files = (await readdir(SET)).filter((f) => f.endsWith('.json'));
const all = [];
for (const f of files) for (const c of JSON.parse(await readFile(path.join(SET, f), 'utf8'))) all.push(c);
const hits = all.filter((c) => c.expect);
const negs = all.filter((c) => !c.expect);
const take = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
const cases = [...take(hits, LIMIT), ...take(negs, Math.max(6, Math.round(LIMIT / 4)))];

console.log(`本地模型评测｜${BASE}｜样本 ${cases.length} 条（正例 ${cases.filter(c=>c.expect).length} / 负例 ${cases.filter(c=>!c.expect).length}）\n`);

async function ask(user) {
  const sys = PERSONA_TONE + GUARD.join('\n') + '\n'
    + '写一段可朗读的口播稿，80-150 字。\n\n'
    + '只输出 JSON：{"pick": 命中的候选序号或 null, "answer": "你的回答"}。若候选都无法回答用户问题，pick 为 null，answer 写"资料里没有这一点"。';
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local', max_tokens: 600, temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: SCHEMA } },
      messages: [{ role: 'user', content: sys + '\n\n' + user }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || '').trim();
}

let ok = 0, wrong = 0, missed = 0, fp = 0, fb = 0, err = 0;
const t0 = Date.now();

for (const [i, c] of cases.entries()) {
  const { top } = search(items, c.q, { topK: 8 });
  const list = top.map((x, n) =>
    `[${n + 1}] ${x.entry.id}\n问法：${x.entry.question}\n内容：${x.entry.answer}`).join('\n\n');
  let got = null;
  try {
    const txt = await ask(`用户问题：${c.q}\n\n【候选资料】\n${list}`);
    const j = JSON.parse(txt);
    const idx = Number(j.pick);
    got = (Number.isInteger(idx) && idx >= 1 && idx <= top.length) ? top[idx - 1].entry.id : null;
  } catch { err++; }

  if (c.expect) {
    if (got === c.expect) ok++;
    else if (got) wrong++;
    else missed++;
  } else {
    if (got) fp++; else fb++;
  }

  if ((i + 1) % 5 === 0) {
    const sec = (Date.now() - t0) / 1000;
    console.log(`  ${i + 1}/${cases.length}  已用 ${sec.toFixed(0)}s  平均 ${(sec / (i + 1)).toFixed(1)}s/条`);
  }
}

const pos = cases.filter((c) => c.expect).length;
const neg = cases.length - pos;
const sec = (Date.now() - t0) / 1000;
console.log('\n—— 结果 ——');
console.log(`召回率（正例选中正确条目）: ${(ok / pos * 100).toFixed(1)}%  ${ok}/${pos}`);
console.log(`选错条目                 : ${wrong}｜未选出 ${missed}`);
console.log(`负例正确弃权             : ${(fb / neg * 100).toFixed(1)}%  ${fb}/${neg}｜误答 ${fp}`);
console.log(`请求失败                 : ${err}`);
console.log(`总耗时 ${sec.toFixed(0)}s｜平均 ${(sec / cases.length).toFixed(1)}s/条`);
