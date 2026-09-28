// 密钥导入 / 导出的回归测试。
// 运行：npm test
//
// 目的：保证「同一个地址」在扩展被删除重装后还能恢复回来，
// 否则每换一次 vault 就得重新生成账号、重新空投。
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair } from 'web3';
import { encodeSecretKey, parseSecretKey } from '../src/keys.js';

// 固定种子 => 测试完全可复现
const keypair = Keypair.fromSeed(new Uint8Array(32).fill(7));
const SECRET = bs58.encode(keypair.secretKey);
const ADDRESS = keypair.publicKey.toBase58();

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function throwsWith(fn, pattern) {
  assert.throws(fn, pattern);
}

test('base58 secret key restores the same address', () => {
  assert.equal(parseSecretKey(SECRET).publicKey.toBase58(), ADDRESS);
});

test('export -> import is an identity round-trip', () => {
  assert.equal(encodeSecretKey(parseSecretKey(SECRET)), SECRET);
});

test('JSON array secret key (Phantom style) restores the same address', () => {
  const json = JSON.stringify(Array.from(keypair.secretKey));
  assert.equal(parseSecretKey(json).publicKey.toBase58(), ADDRESS);
});

test('Uint8Array / number[] / offset view all work', () => {
  assert.equal(parseSecretKey(keypair.secretKey).publicKey.toBase58(), ADDRESS);
  assert.equal(parseSecretKey(Array.from(keypair.secretKey)).publicKey.toBase58(), ADDRESS);

  // 带 byteOffset 的视图不能从 buffer 头开始读
  const padded = new Uint8Array(keypair.secretKey.length + 5);
  padded.set(keypair.secretKey, 5);
  const view = padded.subarray(5);
  assert.equal(view.byteOffset, 5);
  assert.equal(parseSecretKey(view).publicKey.toBase58(), ADDRESS);
});

test('surrounding whitespace and newlines are tolerated', () => {
  assert.equal(parseSecretKey(`  \n${SECRET}\n `).publicKey.toBase58(), ADDRESS);
});

test('a 32 byte value (public key / raw seed) is refused, not silently used as a seed', () => {
  const publicKeyBytes = keypair.publicKey.toBytes();
  assert.equal(publicKeyBytes.length, 32);

  // 关键断言：绝不能悄悄当成 seed 生成另一个地址，
  // 那样用户会以为找回了旧账号，实际把钱打进了新地址。
  throwsWith(() => parseSecretKey(publicKeyBytes), /32 bytes/);
  throwsWith(() => parseSecretKey(bs58.encode(publicKeyBytes)), /not a secret key/);
  throwsWith(() => parseSecretKey(JSON.stringify(Array.from(publicKeyBytes))), /32 bytes/);
});

test('wrong length bytes produce an actionable error', () => {
  throwsWith(() => parseSecretKey(new Uint8Array(63)), /must be 64 bytes, received 63/);
  throwsWith(() => parseSecretKey(new Uint8Array(65)), /must be 64 bytes, received 65/);
});

test('64 bytes that are not a valid ed25519 keypair are rejected', () => {
  const bogus = new Uint8Array(64).fill(9);
  throwsWith(() => parseSecretKey(bogus), /not a valid ed25519 keypair|Secret key must be 64 bytes/);
});

test('invalid base58 is rejected', () => {
  // 0/O/I/l 不属于 base58 字母表
  throwsWith(() => parseSecretKey('0OIl' + SECRET), /not valid base58|must be 64 bytes/);
});

test('empty payload is rejected', () => {
  throwsWith(() => parseSecretKey(''), /empty/);
  throwsWith(() => parseSecretKey('   '), /empty/);
});

test('non-bytes input is rejected with a clear message', () => {
  throwsWith(() => parseSecretKey(null), /must be a base58 string or bytes/);
  throwsWith(() => parseSecretKey(undefined), /must be a base58 string or bytes/);
  throwsWith(() => parseSecretKey({}), /must be a base58 string or bytes/);
});

test('malformed JSON array is rejected', () => {
  throwsWith(() => parseSecretKey('[1,2,3'), /cannot be parsed/);
  throwsWith(() => parseSecretKey('{"a":1}'), /not valid base58|must be 64 bytes/);
  throwsWith(() => parseSecretKey('[1,2,300]'), /between 0 and 255/);
  throwsWith(() => parseSecretKey('[1,2.5]'), /between 0 and 255/);
});

// ------------------------------------------------------------------------ 输出

let failed = 0;
for (const { name, ok, error } of results) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message || error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
