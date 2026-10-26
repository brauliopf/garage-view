const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../protocol');

test('varints preserve 64-bit values', () => {
  const value = 18446744073709551586n;
  const [decoded, end] = P.decVarint(P.encVarint(value));
  assert.equal(decoded, value);
  assert.equal(end, P.encVarint(value).length);
});

test('protobuf bytes and integers round trip', () => {
  const data = Buffer.concat([P.pbInt(1, 7), P.pbBytes(2, Buffer.from('camera'))]);
  const fields = P.pbParse(data);
  assert.equal(fields.get(1)[0], 7n);
  assert.equal(fields.get(2)[0].toString(), 'camera');
});

test('incremental frame parser keeps incomplete input', () => {
  const packet = Buffer.concat([Buffer.from([0x62, 3]), Buffer.from('abc')]);
  let [items, rest] = P.frames(packet.subarray(0, 2));
  assert.equal(items.length, 0);
  [items, rest] = P.frames(Buffer.concat([rest, packet.subarray(2)]));
  assert.equal(items[0].type, 6);
  assert.equal(items[0].body.toString(), 'abc');
});
