// 密钥解析工具。
//
// 不依赖任何 chrome.* API，所以可以直接在 Node 里测试：
//   npm test  ->  scripts/test-keys.mjs
//
// 为什么需要导入功能？
// 加密 vault 存在 chrome.storage.local 里，而 chrome.storage.local 是和「扩展 ID」绑定的。
// manifest 没有 key 字段时，未打包扩展的 ID 由加载路径推导：
// 删除重装、或从别的目录加载 dist/，vault 就没了，只能重新生成地址、重新空投。
// 现在 manifest 固定了 key（ID 恒定），再加上导入私钥，同一个账号就永远找得回来。
import { Keypair } from 'web3';
import bs58 from 'bs58';

const SECRET_KEY_LENGTH = 64; // ed25519: 32 字节 seed + 32 字节 public key
const PUBLIC_KEY_LENGTH = 32;

function toArrayBytes(values) {
  if (!values.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
    throw new Error('Secret key bytes must be integers between 0 and 255.');
  }
  return Uint8Array.from(values);
}

function decodeSecretKeyBytes(input) {
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error('Secret key is empty.');

    // Phantom 等钱包导出的 JSON 数组形式：[12,255,...]
    if (text.startsWith('[')) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Secret key looks like a JSON array but cannot be parsed.');
      }
      if (!Array.isArray(parsed)) {
        throw new Error('Secret key JSON must be an array of numbers.');
      }
      return toArrayBytes(parsed);
    }

    try {
      return bs58.decode(text);
    } catch (error) {
      throw new Error(`Secret key is not valid base58: ${error?.message || error}`);
    }
  }

  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return toArrayBytes(input);

  throw new Error(`Secret key must be a base58 string or bytes, received ${typeof input}.`);
}

/**
 * 把用户粘贴的私钥统一成 Keypair。
 * 支持：base58 字符串（Export Secret Key 的输出）、JSON 数组字符串、Uint8Array、number[]。
 *
 * @param {string|Uint8Array|ArrayBufferView|number[]} input
 * @returns {import('web3').Keypair}
 */
export function parseSecretKey(input) {
  const bytes = decodeSecretKeyBytes(input);

  if (bytes.length === SECRET_KEY_LENGTH) {
    try {
      return Keypair.fromSecretKey(bytes);
    } catch (error) {
      throw new Error(`Secret key is not a valid ed25519 keypair: ${error?.message || error}`);
    }
  }

  // 32 字节必须报错，不能当成 seed：静默生成的是另一个地址，
  // 用户以为找回了旧账号，实际上把币打进了新地址。
  if (bytes.length === PUBLIC_KEY_LENGTH) {
    throw new Error(
      'That is 32 bytes — a public key (or a raw seed), not a secret key. ' +
      'Paste the 64 byte secret key from "Export Secret Key" (88 characters in base58).'
    );
  }

  throw new Error(`Secret key must be 64 bytes, received ${bytes.length} bytes.`);
}

/** 导出用的 base58 私钥字符串。 */
export function encodeSecretKey(keypair) {
  return bs58.encode(keypair.secretKey);
}
