// crypto-mini.mjs —— 一份纯 JS 的极简加密（SHA-256 流密码），浏览器与 Node 共用同一实现。
//
// 为什么不用浏览器的 WebCrypto：单文件页面是 file:// 打开的，crypto.subtle 依赖"安全上下文"。
// 这一前提在本项目里无法用真浏览器验证（构建机上跑不了 headless 浏览器），而它一旦不成立，
// 兜底模型会整体失效且只在用户机器上暴露。所以这里自带一份实现：任何环境都能跑，还能在 Node 里端到端自测。
//
// 说清楚安全边界：**单文件里的"加密"只能防"被直接搜到明文"**。解密所需的一切必须随文件走，
// 有心人照着代码就能还原。要让密钥真正不可得，只能把密钥留在服务端。
// 本模块的作用是：让 HTML 里搜不到明文密钥、让误拷密钥进模板时 build 就报错。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256，输入 Uint8Array，输出 32 字节 Uint8Array */
export function sha256(bytes) {
  const len = bytes.length;
  const bitLen = len * 8;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(total - 4, bitLen >>> 0);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** 由口令与 salt 派生 32 字节密钥（迭代混入，抬高暴力成本；这不是 PBKDF2，够用即可） */
function deriveKey(passphrase, saltBytes) {
  let k = sha256(concat(enc(passphrase), new Uint8Array([0]), saltBytes));
  for (let i = 0; i < 20000; i++) k = sha256(concat(k, saltBytes));
  return k;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

/** SHA-256 计数器模式生成密钥流（自造构造，非标准 AEAD；用途是"防明文外露"，不是抗密码分析） */
function keystream(key, len) {
  const out = new Uint8Array(len);
  const counter = new Uint8Array(4);
  for (let off = 0, i = 0; off < len; off += 32, i++) {
    new DataView(counter.buffer).setUint32(0, i);
    out.set(sha256(concat(concat(key, counter), new Uint8Array([0x7c]))).subarray(0, Math.min(32, len - off)), off);
  }
  return out;
}

const xor = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; };

const b64 = (bytes) => {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
};
const unb64 = (str) => {
  if (typeof atob === 'function') { const s = atob(str); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; }
  return new Uint8Array(Buffer.from(str, 'base64'));
};

/** 加密：明文对象 → {v,salt,ct,mac}
 *  ct 前 4 字节是口令校验头；mac 覆盖**整段密文**，任何一处改动都会被发现。
 *  （最初只放了口令校验头，结果"改了密文中段照样能解开"——校验头保护不到后面，所以补了 mac。） */
export function seal(plainObject, passphrase) {
  const salt = new Uint8Array(16);
  for (let i = 0; i < 16; i++) salt[i] = Math.floor(Math.random() * 256);
  const key = deriveKey(passphrase, salt);
  const body = enc(JSON.stringify(plainObject));
  const check = sha256(concat(key, enc('|check'))).subarray(0, 4);
  const ct = xor(concat(check, body), keystream(key, body.length + 4));
  const mac = sha256(concat(concat(key, enc('|mac')), ct)).subarray(0, 8);
  return { v: 1, salt: b64(salt), ct: b64(ct), mac: b64(mac) };
}

/** 解密：{v,salt,ct,mac} → 明文对象；口令错误或密文被改动一律抛错 */
export function open(sealed, passphrase) {
  if (!sealed || !sealed.ct || !sealed.salt) throw new Error('密文结构不完整');
  const salt = unb64(sealed.salt);
  const key = deriveKey(passphrase, salt);
  const ct = unb64(sealed.ct);
  // 先验 MAC：整段密文任何一位被改动都在这里拦下，避免"改坏了却还能解出半截 JSON"
  const mac = sha256(concat(concat(key, enc('|mac')), ct)).subarray(0, 8);
  const want = unb64(sealed.mac || '');
  if (want.length !== 8) throw new Error('密文缺少完整性校验');
  let diff = 0;
  for (let i = 0; i < 8; i++) diff |= mac[i] ^ want[i];
  if (diff !== 0) throw new Error('口令不正确或密文被改动');
  const raw = xor(ct, keystream(key, ct.length));
  const check = sha256(concat(key, enc('|check'))).subarray(0, 4);
  for (let i = 0; i < 4; i++) if (raw[i] !== check[i]) throw new Error('口令不正确或密文被改动');
  return JSON.parse(dec(raw.subarray(4)));
}
