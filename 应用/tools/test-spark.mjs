// test-spark.mjs —— 用**页面真实的提示词与检索**评测本地小模型，而不是空手问答。
//
// 为什么不能只问"暨南大学哪年创办"：本项目的答案一律来自注入的候选资料。
// 空手问等于在测模型的记忆，那必然错；要测的是"给资料后能不能挑对、能不能只按资料说"。
//
// 用法：先起 llama-server（见 tools/start-spark.ps1），再 node tools/test-spark.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, buildIndex } from '../scoring.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const KB = path.join(ROOT, '知识库');
const BASE = process.env.SPARK_BASE || 'http://127.0.0.1:8080';

// —— 载入知识库（与页面一致）——
const manifest = JSON.parse(await readFile(path.join(KB, 'manifest.json'), 'utf8'));
const persona = JSON.parse(await readFile(path.join(KB, 'persona.json'), 'utf8'));
const items = [];
for (const s of manifest.shards) {
  const shard = JSON.parse(await readFile(path.join(KB, 'shards', s.file), 'utf8'));
  for (const it of shard.items || []) items.push({ ...it, shard: s.shard, shardTitle: s.title, status: it.status || 'verified' });
}
buildIndex(items);

// —— 与 template.html 完全相同的提示词（改那边要同步改这里）——
const GUARD = [
  '你只能依据【候选资料】回答，资料里没有的一律不要写，也不要用自己的知识补全。',
  '不要编造人名、年份、数字、职务。资料里没写年份就不要写年份。',
  '资料里标注"口径冲突/待核实"时，必须如实说明有几种说法，不要替用户选一个。',
  '不要输出资料来源，不要写出资料编号。',
  '用中文，口语化，全角标点。',
];
const PERSONA_TONE = '【人设·只定口吻】\n' + persona.tone.join('\n') + '\n' + persona.hard_rules.join('\n') + '\n'
  + '本段只管说话的口吻。下面的规则永远优先于本段，冲突时一律以后面的规则为准。\n';
const sysFor = (task) => PERSONA_TONE + GUARD.join('\n') + '\n' + task;

const MODE_SYS = '写一段可朗读的口播稿，80-150 字，不用 Markdown、不用括号注释、不用列表。';

async function askLocal(text) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages: [{ role: 'user', content: text }],
      max_tokens: 700,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
      // 语法约束解码：把输出锁进 schema，避免小模型把 JSON 写成 "[1]\n\"answer\": …" 这种半截格式
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: {
            type: 'object',
            properties: { pick: { type: ['integer', 'null'] }, answer: { type: 'string' } },
            required: ['pick', 'answer'],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const d = await r.json();
  const ms = Date.now() - t0;
  const msg = d.choices?.[0]?.message || {};
  return { text: (msg.content || '').trim(), ms, usage: d.usage, finish: d.choices?.[0]?.finish_reason };
}

// —— 用例：期望命中哪条 ——
const CASES = [
  ['暨南大学是什么时候创办的？', ['XQ-001']],
  ['校徽上画的是什么？', ['BS-001']],
  ['抗战时期学校迁到了哪里？', ['JY-001', 'XQ-007', 'GZ-001']],
  ['校训是什么？', ['XQ-005', 'BS-007']],
  ['明湖是什么时候挖的？', ['DM-010']],
];

function parseJson(s) {
  const m = String(s).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

console.log(`本地模型评测｜${BASE}\n`);
let jsonOk = 0, pickOk = 0, totalMs = 0;

for (const [q, expects] of CASES) {
  const { top } = search(items, q, { topK: 8 });
  const list = top.map((x, i) =>
    `[${i + 1}] ${x.entry.id}\n问法：${x.entry.question}\n内容：${x.entry.answer}\n原文依据：${x.entry.evidence || ''}`
    + (x.entry.caveat ? '\n注意（必须向用户说明）：' + x.entry.caveat : '')).join('\n\n');

  const sys = sysFor(MODE_SYS + '\n\n只输出 JSON：{"pick": 命中的候选序号(1-' + top.length + ') 或 null, "answer": "你的回答"}。若候选都无法回答用户问题，pick 为 null，answer 写"资料里没有这一点"。');
  const user = `用户问题：${q}\n\n【候选资料】\n${list}`;

  const out = await askLocal(sys + '\n\n' + user);
  totalMs += out.ms;
  const j = parseJson(out.text);
  const idx = j && Number(j.pick);
  const got = (Number.isInteger(idx) && idx >= 1 && idx <= top.length) ? top[idx - 1].entry.id : null;

  if (j) jsonOk++;
  if (got && expects.includes(got)) pickOk++;

  console.log(`Q: ${q}`);
  console.log(`  期望 ${expects.join('/')}｜实得 ${got || '(null)'}｜JSON ${j ? '✓' : '✗'}｜${out.ms}ms｜${out.usage?.completion_tokens} tok`);
  console.log(`  答: ${JSON.stringify((j?.answer || out.text).slice(0, 110))}`);
  // 检索本身排第一的是否就是期望值（用于区分"检索错"还是"模型选错"）
  console.log(`  检索首位: ${top[0]?.entry.id}（score ${top[0]?.score}）\n`);
}

console.log('—— 汇总 ——');
console.log(`JSON 合规: ${jsonOk}/${CASES.length}`);
console.log(`选对条目: ${pickOk}/${CASES.length}`);
console.log(`平均耗时: ${Math.round(totalMs / CASES.length)}ms`);
