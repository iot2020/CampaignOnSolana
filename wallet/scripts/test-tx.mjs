// 交易解析 / 签名逻辑的回归测试。
// 运行：npm test
//
// 覆盖 DApp 可能发过来的四种字节形态：
//   legacy 完整交易 / legacy 仅 message / v0 完整交易 / v0 仅 message
// 其中「legacy 仅 message」就是原来报 "Reached end of buffer unexpectedly" 的那种。
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction
} from 'web3';
import { PACKET_DATA_SIZE, signRawTransaction } from '../src/tx.js';

// 用全零 blockhash 代替真实 RPC 调用（bs58 编码为 "11111111111111111111111111111111"）
const BLOCKHASH = bs58.encode(new Uint8Array(32));
// 固定种子 => 测试完全可复现（旧解析器的报错内容取决于具体字节）
const payer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function transferInstruction(fromPubkey, toPubkey = RECIPIENT, lamports = 0.01 * LAMPORTS_PER_SOL) {
  return SystemProgram.transfer({ fromPubkey, toPubkey, lamports });
}

function legacyTransaction(signers = [payer.publicKey]) {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH });
  for (const from of signers) tx.add(transferInstruction(from));
  return tx;
}

function v0Message() {
  return new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [transferInstruction(payer.publicKey)]
  }).compileToV0Message();
}

// 多笔指令的大消息：被当成完整交易解析时会一路读到缓冲区末尾，
// 正好复现用户看到的 "Reached end of buffer unexpectedly"
// （收款账户必须各不相同，否则 Message.compile 会去重，消息就变小了）
function bigLegacyMessage(instructionCount = 12) {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH });
  for (let i = 1; i <= instructionCount; i++) {
    const recipient = Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey;
    tx.add(transferInstruction(payer.publicKey, recipient, i));
  }
  return new Uint8Array(tx.serializeMessage());
}

// 校验后台返回的字节确实是一笔可广播、签名有效的完整交易
function assertSignedTransaction(signed, keypair, label) {
  const tx = VersionedTransaction.deserialize(Uint8Array.from(signed));
  const signature = tx.signatures[0];

  assert.equal(signature.length, 64, `${label}: signature must be 64 bytes`);
  assert.notDeepEqual(
    Uint8Array.from(signature),
    new Uint8Array(64),
    `${label}: signature slot must not stay empty`
  );
  assert.ok(
    nacl.sign.detached.verify(tx.message.serialize(), signature, keypair.publicKey.toBytes()),
    `${label}: signature must verify against the serialized message`
  );
  assert.ok(
    tx.message.staticAccountKeys[0].equals(keypair.publicKey),
    `${label}: fee payer must be the signing key`
  );
  assert.ok(signed.length <= PACKET_DATA_SIZE, `${label}: transaction must fit in one packet`);
  return tx;
}

// ---------------------------------------------------------------- 四种输入形态

test('legacy: full serialized transaction', () => {
  const raw = new Uint8Array(
    legacyTransaction().serialize({ requireAllSignatures: false, verifySignatures: false })
  );
  const result = signRawTransaction(raw, payer);
  assert.equal(result.input, 'transaction');
  assert.equal(result.kind, 'legacy transaction');
  assertSignedTransaction(result.signed, payer, 'legacy full tx');
});

test('legacy: serialized message only (the "Reached end of buffer" case)', () => {
  const raw = new Uint8Array(legacyTransaction().serializeMessage());

  // 旧实现只会按「完整交易」解析这份字节：把 message 的第一个字节
  // (numRequiredSignatures) 当成签名数量，后续读取整体错位。
  // 具体报错取决于消息长度 —— 长的消息会一路读到缓冲区末尾，
  // 正是用户看到的 "Reached end of buffer unexpectedly"。
  assert.throws(
    () => VersionedTransaction.deserialize(bigLegacyMessage()),
    /Reached end of buffer unexpectedly/,
    'old code path must reproduce the reported error'
  );
  assert.throws(
    () => VersionedTransaction.deserialize(raw),
    /Expected signatures length|Reached end of buffer|deserialization is not supported/,
    'old code path must fail on message-only bytes'
  );

  const result = signRawTransaction(raw, payer);
  assert.equal(result.input, 'message');
  assert.equal(result.kind, 'legacy message');
  assertSignedTransaction(result.signed, payer, 'legacy message');
  // DApp 侧一般会用 Transaction.from 拿回签名
  assert.ok(Transaction.from(Uint8Array.from(result.signed)).verifySignatures(true));
});

test('legacy: large serialized message signs correctly', () => {
  const raw = bigLegacyMessage();
  const result = signRawTransaction(raw, payer);
  assert.equal(result.input, 'message');
  assert.equal(result.kind, 'legacy message');
  const tx = assertSignedTransaction(result.signed, payer, 'big legacy message');
  assert.equal(tx.message.staticAccountKeys.length, 14);
});

test('v0: full serialized transaction', () => {
  const raw = new Uint8Array(new VersionedTransaction(v0Message()).serialize());
  const result = signRawTransaction(raw, payer);
  assert.equal(result.input, 'transaction');
  assert.equal(result.kind, 'v0 transaction');
  assertSignedTransaction(result.signed, payer, 'v0 full tx');
});

test('v0: serialized message only', () => {
  const raw = new Uint8Array(v0Message().serialize());
  const result = signRawTransaction(raw, payer);
  assert.equal(result.input, 'message');
  assert.equal(result.kind, 'v0 message');
  assertSignedTransaction(result.signed, payer, 'v0 message');
});

test('legacy: already signed transaction stays valid', () => {
  const tx = legacyTransaction();
  // 注意：Transaction.sign/partialSign 是可变参数，VersionedTransaction.sign 才接受数组
  tx.sign(payer);
  const result = signRawTransaction(new Uint8Array(tx.serialize()), payer);
  assert.equal(result.input, 'transaction');
  assertSignedTransaction(result.signed, payer, 'pre-signed tx');
});

// ------------------------------------------------------------------ 部分签名

test('multi-signer message: partial signing keeps the empty slot', () => {
  const coSigner = Keypair.generate();
  const raw = new Uint8Array(
    legacyTransaction([payer.publicKey, coSigner.publicKey]).serializeMessage()
  );

  const result = signRawTransaction(raw, payer, { requireAllSignatures: false });
  const tx = Transaction.from(Uint8Array.from(result.signed));

  assert.equal(tx.signatures.length, 2);
  assert.ok(tx.signatures[0].signature, 'our own signature must be present');
  assert.equal(tx.signatures[1].signature, null, 'other signer slot must stay empty');
  assert.ok(
    nacl.sign.detached.verify(
      tx.serializeMessage(),
      tx.signatures[0].signature,
      payer.publicKey.toBytes()
    ),
    'partial signature must verify'
  );
});

test('multi-signer message: sending without all signatures fails loudly', () => {
  const coSigner = Keypair.generate();
  const raw = new Uint8Array(
    legacyTransaction([payer.publicKey, coSigner.publicKey]).serializeMessage()
  );
  assert.throws(() => signRawTransaction(raw, payer), /Missing signature/);
});

test('wrong key: a signer that is not required is rejected', () => {
  const stranger = Keypair.generate();
  const raw = new Uint8Array(legacyTransaction().serializeMessage());
  assert.throws(
    () => signRawTransaction(raw, stranger),
    /Cannot sign with non signer key|unknown signer/
  );
});

// -------------------------------------------------------------------- 报错质量

test('garbage bytes produce an actionable error', () => {
  const garbage = new Uint8Array(64).fill(7);
  assert.throws(() => signRawTransaction(garbage, payer), /Unable to parse the transaction/);
});

test('empty payload is rejected', () => {
  assert.throws(() => signRawTransaction(new Uint8Array(0), payer), /empty/);
  assert.throws(() => signRawTransaction(null, payer), /missing/i);
});

test('oversized payload is rejected', () => {
  const tooBig = new Uint8Array(PACKET_DATA_SIZE + 1);
  assert.throws(() => signRawTransaction(tooBig, payer), /larger than the 1232 byte/);
});

test('non-bytes payload is rejected with a clear message', () => {
  assert.throws(() => signRawTransaction('5eyU...', payer), /must be a Uint8Array/);
});

test('byte containers: offset views and plain arrays work', () => {
  const raw = new Uint8Array(legacyTransaction().serializeMessage());

  // 带偏移量的视图（node Buffer / subarray 都是这种）
  const padded = new Uint8Array(raw.length + 8).fill(0xff);
  padded.set(raw, 8);
  const view = padded.subarray(8);
  assert.equal(view.byteOffset, 8);
  assert.equal(signRawTransaction(view, payer).kind, 'legacy message');

  // 普通数组
  assert.equal(signRawTransaction(Array.from(raw), payer).kind, 'legacy message');
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


