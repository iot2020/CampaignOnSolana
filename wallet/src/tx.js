// 交易解析 / 签名工具。
//
// 这里不依赖任何 chrome.* API，所以可以直接在 Node 里测试：
//   npm test  ->  scripts/test-tx.mjs
//
// 为什么需要这个文件？
// DApp 通过 Wallet Standard 传过来的 `transaction` 字节，实际上有两种常见形态：
//   1. 完整序列化交易（signatureCount + signatures + message）
//   2. 只序列化了 message（`tx.serializeMessage()` / `message.serialize()`）
//      —— wallet-adapter 的 legacy 分支和很多手写 Wallet Standard 代码都会这样传。
// 只按形态 1 解析形态 2 的字节，读取位置会整体错位，最后缓冲区被读完，
// web3.js 抛出 "Reached end of buffer unexpectedly"。

import {
  Transaction,
  VersionedMessage,
  VersionedTransaction
} from 'web3';

// 单笔交易上链的字节上限，超过这个值一定不是合法交易，用来提前给出清晰报错
export const PACKET_DATA_SIZE = 1232;

// versioned message 前缀掩码：最高位为 1 => v0/v1 message，最高位为 0 => legacy
const VERSION_PREFIX_MASK = 0x7f;

/** 把任意字节容器统一成 Uint8Array，顺便挡住「DApp 传了字符串」这类错误。 */
export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value === null || value === undefined) {
    throw new Error('Transaction payload is missing (expected a Uint8Array).');
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error(`Transaction must be a Uint8Array, received ${typeof value}.`);
}

/** 给日志和报错用的字节摘要。 */
export function preview(bytes) {
  const head = Array.from(bytes.slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
  return `${bytes.length} bytes [${head}${bytes.length > 8 ? ' ...' : ''}]`;
}

// 完整交易的第一个字节是 compact-u16 的签名数量（几乎总是 < 0x80）；
// 第一个字节最高位被置位，就说明这是一段 versioned message。
function startsWithVersionPrefix(bytes) {
  return (bytes[0] & ~VERSION_PREFIX_MASK) !== 0;
}

/** 形态 1：完整序列化交易（legacy / v0 / v1 都能被 VersionedTransaction 吃掉）。 */
function signSerializedTransaction(bytes, keypair) {
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([keypair]);
  return {
    kind: tx.version === 'legacy' ? 'legacy transaction' : `v${tx.version} transaction`,
    signed: Uint8Array.from(tx.serialize())
  };
}

/** 形态 2：只有 message 的字节。 */
function signSerializedMessage(bytes, keypair, requireAllSignatures) {
  const message = VersionedMessage.deserialize(bytes);

  // legacy message 走 Transaction，这样可以支持多签场景下的部分签名
  if (message.version === 'legacy') {
    const tx = Transaction.populate(message);
    tx.partialSign(keypair);
    return {
      kind: 'legacy message',
      signed: Uint8Array.from(
        tx.serialize({ requireAllSignatures, verifySignatures: true })
      )
    };
  }

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);
  return {
    kind: `v${message.version} message`,
    signed: Uint8Array.from(tx.serialize())
  };
}

/**
 * 用 keypair 签名 DApp 传来的交易字节，返回完整可广播的 wire transaction。
 *
 * @param {Uint8Array|ArrayBufferView|number[]} raw DApp 传来的交易/消息字节
 * @param {import('web3').Keypair} keypair 签名密钥
 * @param {{requireAllSignatures?: boolean}} [options] false 表示允许部分签名（signTransaction 用）
 * @returns {{signed: Uint8Array, kind: string, input: 'transaction'|'message', length: number}}
 */
export function signRawTransaction(raw, keypair, options = {}) {
  const { requireAllSignatures = true } = options;
  const bytes = toBytes(raw);

  if (bytes.length === 0) {
    throw new Error('Transaction payload is empty (0 bytes).');
  }
  if (bytes.length > PACKET_DATA_SIZE) {
    throw new Error(
      `Transaction is ${bytes.length} bytes, larger than the ${PACKET_DATA_SIZE} byte on-chain limit.`
    );
  }

  const attempts = startsWithVersionPrefix(bytes)
    ? [['message', signSerializedMessage], ['transaction', signSerializedTransaction]]
    : [['transaction', signSerializedTransaction], ['message', signSerializedMessage]];

  const failures = [];

  for (const [label, attempt] of attempts) {
    try {
      const result = attempt(bytes, keypair, requireAllSignatures);
      return { ...result, input: label, length: bytes.length };
    } catch (error) {
      failures.push(`${label}: ${error?.message || error}`);
    }
  }

  throw new Error(
    `Unable to parse the transaction sent by the dApp (${preview(bytes)}). Tried ${failures.join(' | ')}`
  );
}
