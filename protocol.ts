const crypto = require('node:crypto');

const PORT = 20190;
const UDP_PREFIX = Buffer.from([0x51, 0x70]);
const HB_CONST = 18446744073709551586n;
const CMD = { LANAUTH: 2650, VIDEOPLAY: 2610, HELLO: 106, PING: 107, STATUS: 2780 };
const MAX_FRAME = 8 * 1024 * 1024;

function encVarint(value) {
  let n = BigInt(value), out = [];
  do { out.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(out);
}
function decVarint(buf, offset = 0) {
  let value = 0n;
  for (let i = offset; i < buf.length && i < offset + 10; i++) {
    value |= BigInt(buf[i] & 127) << BigInt((i - offset) * 7);
    if (!(buf[i] & 128)) return [value, i + 1];
  }
  throw new Error('truncated varint');
}
function pbBytes(field, value) { return Buffer.concat([encVarint((field << 3) | 2), encVarint(value.length), value]); }
function pbInt(field, value) { return Buffer.concat([encVarint(field << 3), encVarint(value)]); }
function pbParse(buf) {
  const out = new Map(); let i = 0;
  while (i < buf.length) {
    let tag, next; try { [tag, next] = decVarint(buf, i); } catch { break; }
    i = next; const field = Number(tag >> 3n), type = Number(tag & 7n); let value;
    try {
      if (type === 0) [value, i] = decVarint(buf, i);
      else if (type === 2) { let n; [n, i] = decVarint(buf, i); n = Number(n); if (i + n > buf.length) break; value = buf.subarray(i, i + n); i += n; }
      else break;
    } catch { break; }
    if (!out.has(field)) out.set(field, []); out.get(field).push(value);
  }
  return out;
}
function prekey() {
  const value = process.env.A9_PREKEY;
  if (!value) throw new Error('A9_PREKEY is not set (set it in the environment or .env)');
  return Buffer.from(value);
}
function key(cmd, seq, rpc) { return crypto.createHash('md5').update(`${prekey()},ID:${cmd}-SEQ:${seq}-RPC:${rpc}`).digest('hex'); }
function crypt(cmd, seq, rpc, plaintext, decrypt = false) {
  if (!plaintext.length) return Buffer.alloc(0);
  const k = Buffer.from(key(cmd, seq, rpc));
  const decipher = decrypt ? crypto.createDecipheriv('aes-256-cbc', k, k.subarray(0, 16)) : crypto.createCipheriv('aes-256-cbc', k, k.subarray(0, 16));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(plaintext), decipher.final()]);
}
function ctrlEncrypt(cmd, seq, rpc, plain) {
  const pad = 16 - (plain.length % 16);
  return crypt(cmd, seq, rpc, Buffer.concat([plain, Buffer.alloc(pad, pad)]));
}
function ctrlDecrypt(cmd, seq, rpc, encrypted) {
  if (!encrypted.length || encrypted.length % 16) return null;
  const plain = crypt(cmd, seq, rpc, encrypted, true), pad = plain.at(-1);
  return pad >= 1 && pad <= 16 && plain.subarray(-pad).every(x => x === pad) ? plain.subarray(0, -pad) : null;
}
function buildCtrl(seq, cmd, plain = Buffer.alloc(0), flag = 0x0c) {
  const rpc = flag & 3, header = Buffer.concat([encVarint(seq), encVarint(cmd), Buffer.from([flag]), ...(rpc === 1 ? [encVarint(0)] : [])]);
  const body = Buffer.concat([header, ctrlEncrypt(cmd, seq, rpc, plain)]);
  return Buffer.concat([Buffer.from([0x48]), encVarint(body.length), body]);
}
function ctrlHeader(body) {
  let i = 0, seq, cmd; [seq, i] = decVarint(body, i); [cmd, i] = decVarint(body, i);
  const flag = body[i++], rpc = flag & 3; if (rpc === 1) [, i] = decVarint(body, i);
  return { seq, cmd: Number(cmd), rpc, encrypted: body.subarray(i) };
}
function frames(buffer) {
  const result = []; let i = 0;
  while (i < buffer.length) {
    const type = buffer[i] >> 4; if (![2, 3, 4, 5, 6, 7, 8].includes(type)) { i++; continue; }
    let n, j; try { [n, j] = decVarint(buffer, i + 1); } catch { break; }
    n = Number(n); if (n <= 0 || n > MAX_FRAME || j + n > buffer.length) break;
    result.push({ type, flag: buffer[i] & 15, body: buffer.subarray(j, j + n) }); i = j + n;
  }
  return [result, buffer.subarray(i)];
}
function mediaHeader(body) {
  let i = 2, values = []; for (let n = 0; n < 5; n++) { let v; [v, i] = decVarint(body, i); values.push(v); }
  return { avch: values[0], avseq: values[1], tt: values[2], encryptedLength: Number(values[3]), data: body.subarray(i + 2) };
}
function decryptMedia(fragments, sessionKey) {
  let output = [];
  for (const body of fragments) {
    const h = mediaHeader(body); let data = h.data;
    if (h.encryptedLength) {
      const k = crypto.createHash('md5').update(`${sessionKey},AVSeq:${h.avseq}-TT:${h.tt}-AVChannel:${h.avch}`).digest('hex');
      const n = Math.min(h.encryptedLength - h.encryptedLength % 16, data.length - data.length % 16);
      const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k), Buffer.from(k).subarray(16, 32)); d.setAutoPadding(false);
      data = Buffer.concat([d.update(data.subarray(0, n)), d.final(), data.subarray(n)]);
    }
    output.push(data);
  }
  const blob = Buffer.concat(output), soi = blob.indexOf(Buffer.from([0xff, 0xd8]));
  const eoi = soi < 0 ? -1 : blob.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
  return soi >= 0 && eoi >= 0 ? blob.subarray(soi, eoi + 2) : null;
}
function status(plain) {
  const outer = pbParse(plain), inner = outer.get(1)?.[0]; if (!Buffer.isBuffer(inner)) return null;
  const o = pbParse(inner), result = { did: o.get(2)?.[0]?.toString() ?? null, ts: o.get(6)?.[0] == null ? null : Number(o.get(6)[0]) };
  const nested = o.get(4)?.[0]; if (!Buffer.isBuffer(nested)) return result;
  const n = pbParse(nested), flags = n.get(2)?.[0];
  if (Buffer.isBuffer(flags)) { result.status_bytes = flags.toString('hex'); if (flags.length > 1) result.battery = flags[1]; if (flags.length) result.flag0 = flags[0]; }
  if (n.get(1)?.[0] != null) result.field1 = Number(n.get(1)[0]);
  const info = (n.get(4) || []).filter(Buffer.isBuffer).filter(x => [...x].every(c => c >= 32 && c < 127)).map(x => x.toString());
  if (info.length) result.info = info;
  return result;
}
function discoveryPing() { const body = Buffer.from([1, 0xa8, 0x14, 0x0c]); return Buffer.concat([UDP_PREFIX, Buffer.from([0x48, body.length]), body]); }
function parseDiscovery(data, source) {
  if (data.length < 6 || !data.subarray(0, 2).equals(UDP_PREFIX) || data[2] >> 4 !== 4) return null;
  try { let n, i; [n, i] = decVarint(data, 3); const h = ctrlHeader(data.subarray(i, i + Number(n))), plain = ctrlDecrypt(h.cmd, h.seq, h.rpc, h.encrypted); if (!plain) return null; const f = pbParse(plain), str = n => f.get(n)?.[0]?.toString(); return { did: str(1), ip: source, port: Number(f.get(4)?.[0] ?? PORT), fw: str(5), secret: str(8) }; } catch { return null; }
}
module.exports = { PORT, UDP_PREFIX, HB_CONST, CMD, encVarint, decVarint, pbBytes, pbInt, pbParse, ctrlDecrypt, buildCtrl, ctrlHeader, frames, decryptMedia, status, discoveryPing, parseDiscovery };
