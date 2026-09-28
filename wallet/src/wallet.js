import { registerWallet } from '@wallet-standard/core';

const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTIiIGZpbGw9IiM0NDQiLz48cGF0aCBkPSJNMTIgMTJoMjR2MjRIMTJ6IiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==';
const CHAINS = ['solana:devnet', 'solana:mainnet'];
const TRANSACTION_VERSIONS = ['legacy', 0];
const FEATURES = ['solana:signTransaction', 'solana:signAndSendTransaction'];

// postMessage 只能传可结构化克隆的数据，交易字节用 base64 字符串过桥。
// 这里分块处理，避免 String.fromCharCode(...tx) 在交易较大时超出实参上限。
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Wallet Standard 要求交易以 Uint8Array 传递。DApp 传错类型时，
// 如果直接 base64 编码会得到一串垃圾字节，后台只能报 "Reached end of buffer"，
// 所以在源头就给出明确报错。
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error(
    `transaction must be a Uint8Array, received ${value === null ? 'null' : typeof value}`
  );
}

function request(action, payload = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      if (event.source !== window) return;
      const m = event.data;
      if (m?.source !== 'minimal-solana-wallet-response' || m.id !== id) return;
      window.removeEventListener('message', handler);
      if (m.ok) resolve(m); else reject(new Error(m.error || 'Wallet request failed'));
    };
    window.addEventListener('message', handler);
    window.postMessage({source:'minimal-solana-wallet', id, action, ...payload}, '*');
  });
}

let accounts = [];

const wallet = {
  version: '1.0.0',
  name: 'Minimal Solana Wallet',
  icon: ICON,
  chains: CHAINS,
  get accounts() { return accounts; },
  features: {
    'standard:connect': {
      version: '1.0.0',
      connect: async () => {
        const r = await request('getAccount');
        accounts = [{
          address: r.address,
          publicKey: fromBase64(r.publicKey),
          chains: CHAINS,
          features: FEATURES
        }];
        return { accounts };
      }
    },
    'standard:disconnect': {
      version: '1.0.0',
      disconnect: async () => { accounts = []; }
    },
    'solana:signTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: TRANSACTION_VERSIONS,
      signTransaction: async (...inputs) => {
        const outputs = [];
        for (const input of inputs) {
          const r = await request('signTransaction', {
            transaction: toBase64(asBytes(input.transaction)),
            chain: input.chain
          });
          outputs.push({ signedTransaction: fromBase64(r.signedTransaction) });
        }
        return outputs;
      }
    },
    'solana:signAndSendTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: TRANSACTION_VERSIONS,
      signAndSendTransaction: async (...inputs) => {
        const outputs = [];
        for (const input of inputs) {
          const r = await request('signAndSendTransaction', {
            transaction: toBase64(asBytes(input.transaction)),
            chain: input.chain,
            options: {
              commitment: input.commitment,
              preflightCommitment: input.preflightCommitment,
              skipPreflight: input.skipPreflight,
              minContextSlot: input.minContextSlot,
              maxRetries: input.maxRetries
            }
          });
          outputs.push({ signature: fromBase64(r.signature) });
        }
        return outputs;
      }
    }
  }
};

registerWallet(wallet);

