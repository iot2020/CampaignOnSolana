import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from 'web3';
import bs58 from 'bs58';
import { encodeSecretKey, parseSecretKey } from './keys.js';
import { signRawTransaction } from './tx.js';

const STORE = 'minimal_wallet_v2';
const SESSION_SECRET = 'minimal_wallet_unlocked_secret';
const NETWORK_KEY = 'network';
let unlocked = null;

const endpoints = {
  'solana:devnet': 'https://api.devnet.solana.com',
  'solana:mainnet': 'https://api.mainnet-beta.solana.com'
};

// 分块做 base64，避免大交易时 String.fromCharCode(...) 撑爆调用栈
function b64(data) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function bytes(s) {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 当前在 popup 里选择的网络，默认 devnet。 */
async function currentNetwork() {
  const stored = await chrome.storage.local.get(NETWORK_KEY);
  return stored[NETWORK_KEY] === 'mainnet' ? 'mainnet' : 'devnet';
}

/**
 * 钱包 popup 里选择的网络优先，DApp 传来的 chain 只作为兜底。
 * 否则 DApp 传 solana:mainnet 时，用户明明在 devnet 测试也会把交易发到主网。
 */
async function resolveEndpoint(chain) {
  const network = await currentNetwork();
  const requested = chain === 'solana:mainnet' ? 'mainnet' : chain === 'solana:devnet' ? 'devnet' : null;

  if (requested && requested !== network) {
    console.warn(
      `[Wallet] dApp requested ${chain} but the wallet is set to ${network}; using ${network}.`
    );
  }

  return endpoints[`solana:${network}`];
}

/** 把 DApp 传来的发送参数透传给 RPC。 */
function sendOptions(options = {}) {
  return {
    skipPreflight: options.skipPreflight === true,
    preflightCommitment: options.preflightCommitment || options.commitment,
    maxRetries: options.maxRetries,
    minContextSlot: options.minContextSlot
  };
}

async function derive(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:250000, hash:'SHA-256' },
    base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
  );
}
async function encrypt(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, secret));
  return { salt:b64(salt), iv:b64(iv), ciphertext:b64(ciphertext) };
}
async function decrypt(record, password) {
  const key = await derive(password, bytes(record.salt));
  return new Uint8Array(await crypto.subtle.decrypt(
    {name:'AES-GCM', iv:bytes(record.iv)}, key, bytes(record.ciphertext)
  ));
}
async function getStore() {
  const x = await chrome.storage.local.get(STORE);
  return x[STORE] || null;
}

async function saveUnlocked(kp) {
    unlocked = kp;

    await chrome.storage.session.set({
        [SESSION_SECRET]: b64(kp.secretKey)
    });
}

async function clearUnlocked() {
    unlocked = null;

    await chrome.storage.session.remove(SESSION_SECRET);
}

async function getUnlocked() {
    if (unlocked) {
        return unlocked;
    }

    const result = await chrome.storage.session.get(
        SESSION_SECRET
    );

    const encoded = result[SESSION_SECRET];

    if (!encoded) {
        return null;
    }

    try {
        const secret = bytes(encoded);
        const kp = Keypair.fromSecretKey(secret);

        const stored = await getStore();

        if (
            stored &&
            kp.publicKey.toBase58() === stored.address
        ) {
            unlocked = kp;
            return kp;
        }

        await chrome.storage.session.remove(
            SESSION_SECRET
        );

        return null;

    } catch {
        await chrome.storage.session.remove(
            SESSION_SECRET
        );

        return null;
    }
}

// 密码过短时 PBKDF2 派生出的密钥很容易被暴力破解，后台也挡一次（popup 的前端校验可被绕过）
function requirePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  return password;
}

/** 把密钥写进加密 vault 并解锁（CREATE / IMPORT 共用）。返回地址。 */
async function saveVault(kp, password) {
  const encrypted = await encrypt(kp.secretKey, requirePassword(password));
  const address = kp.publicKey.toBase58();
  await chrome.storage.local.set({
    [STORE]: { version: 1, address, encrypted }
  });
  await saveUnlocked(kp);
  return address;
}

// ── 界面挂在哪：侧边栏（Side Panel）优先，独立窗口作为补充 ──────────────────
//
// action 的 default_popup 是「工具栏弹窗」：它由浏览器托管，失去焦点的那一刻 Chrome
// 就把整个文档销毁，onblur / preventDefault 都拦不住，这是硬性行为，不是 bug。
// 想让它像 Phantom 一样常驻在浏览器边上，只能用 Side Panel（Chrome 114+）——
// 那是浏览器窗口里一块真正的、宽度可拖的面板，失焦、切标签页、跳页面都不会关。
//
// 老 Chrome 没有 chrome.sidePanel，退化成「独立 popup 窗口」：同样不会失焦就关。
const HAS_SIDE_PANEL = typeof chrome.sidePanel !== 'undefined';
const WINDOW_KEY = 'minimal_wallet_window';

if (HAS_SIDE_PANEL) {
  // 点工具栏图标 → 打开侧边栏。设了这个，action.onClicked 就不再触发。
  // service worker 每次被唤醒都重设一遍，幂等，成本可以忽略。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn('[Wallet] setPanelBehavior failed:', error?.message || error));
} else {
  chrome.action.onClicked.addListener(() => {
    openWalletWindow().catch(
      (error) => console.warn('[Wallet] openWalletWindow failed:', error?.message || error)
    );
  });
}

/** 独立窗口的 id 落在 session 里：service worker 被回收后还能认出已经开着的那个窗口。 */
async function rememberWindow(id) {
  if (id === null) await chrome.storage.session.remove(WINDOW_KEY);
  else await chrome.storage.session.set({ [WINDOW_KEY]: id });
}

/**
 * 打开独立钱包窗口；已经开着就把它拉到前面，而不是每点一次多开一个。
 * 独立窗口和侧边栏共用同一个 service worker 和同一份 storage，所以状态天然一致。
 */
async function openWalletWindow() {
  const stored = await chrome.storage.session.get(WINDOW_KEY);
  const previous = stored[WINDOW_KEY];

  if (typeof previous === 'number') {
    try {
      const existing = await chrome.windows.get(previous);
      await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
      return existing.id;
    } catch {
      // 用户已经把它关掉了，session 里的 id 作废
      await rememberWindow(null);
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 400,
    height: 660,
    focused: true
  });

  await rememberWindow(win.id);
  console.log('[Wallet] Opened standalone window:', win.id);
  return win.id;
}

// 窗口被关掉时清掉记录，下次点击才会重新创建
chrome.windows.onRemoved.addListener(async (windowId) => {
  const stored = await chrome.storage.session.get(WINDOW_KEY);
  if (stored[WINDOW_KEY] === windowId) await rememberWindow(null);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // 界面自身的请求（和密钥、签名无关），先处理掉，省一次 vault 读取
      if (msg.type === 'OPEN_WINDOW') {
        const windowId = await openWalletWindow();
        return sendResponse({ok:true, windowId});
      }

      if (msg.type === 'OPEN_TAB') {
        const tab = await chrome.tabs.create({
          url: chrome.runtime.getURL('popup.html'),
          active: true
        });
        return sendResponse({ok:true, tabId: tab.id});
      }

      const stored = await getStore();

      if (msg.type === 'CREATE') {
        // 绝不静默覆盖已有 vault：那等于把用户已经空投过 SOL 的地址丢掉
        if (stored) {
          throw new Error(
            `Wallet already exists (${stored.address}). Reset it first if you want a new account.`
          );
        }
        const address = await saveVault(Keypair.generate(), msg.password);
        return sendResponse({ok:true, exists:true, unlocked:true, address});
      }

      // 导入已有私钥。扩展被删除重装、或从别的目录加载 dist/ 之后，
      // 用同一份私钥就能拿回同一个地址和里面的余额，不用重新空投。
      if (msg.type === 'IMPORT') {
        if (stored && msg.overwrite !== true) {
          throw new Error(
            `Wallet already exists (${stored.address}). Use "Reset wallet" first — and export its secret key before you do.`
          );
        }
        const kp = parseSecretKey(msg.secretKey);
        const address = await saveVault(kp, msg.password);
        console.log('[Wallet] Imported account:', address);
        return sendResponse({ok:true, exists:true, unlocked:true, address, imported:true});
      }

      if (msg.type === 'UNLOCK') {
        if (!stored) throw new Error('No wallet found.');
        let secret;
        try {
          secret = await decrypt(stored.encrypted, msg.password);
        } catch {
          // AES-GCM 解密失败只会抛一个笼统的 OperationError，翻译成用户能看懂的话
          throw new Error('Wrong password.');
        }
        const kp = Keypair.fromSecretKey(secret);
        if (kp.publicKey.toBase58() !== stored.address) throw new Error('Wallet integrity check failed.');
        await saveUnlocked(kp);
        return sendResponse({ok:true, exists:true, unlocked:true, address:kp.publicKey.toBase58()});
      }

      if (msg.type === 'LOCK') {
        await clearUnlocked();
        return sendResponse({ok:true});
      }

      if (msg.type === 'STATE') {
        const kp = await getUnlocked();
        return sendResponse({
          ok:true, exists:!!stored, unlocked:!!kp,
          address: stored?.address || null
        });
      }

      if (msg.type === 'EXPORT') {
        const kp = await getUnlocked();
        if (!kp) throw new Error('Please unlock the wallet first.');
        return sendResponse({ok:true, secretKey:encodeSecretKey(kp), address:kp.publicKey.toBase58()});
      }

      // 清空 vault。只由 popup 的二次确认触发，之后这个地址就再也解不开了，
      // 所以 popup 会先提示导出私钥。
      if (msg.type === 'RESET') {
        if (msg.confirm !== true) throw new Error('Reset must be confirmed.');
        const address = stored?.address || null;
        await clearUnlocked();
        await chrome.storage.local.remove(STORE);
        console.log('[Wallet] Vault cleared for', address);
        return sendResponse({ok:true, exists:false, address});
      }

      if (msg.type === 'BALANCE') {
        if (!stored) throw new Error('No wallet found.');
        const endpoint = await resolveEndpoint();
        const connection = new Connection(endpoint, 'confirmed');
        const lamports = await connection.getBalance(new PublicKey(stored.address));
        return sendResponse({ok:true, lamports, endpoint});
      }

      // Devnet 空投：省掉每次都用 solana airdrop 命令行
      if (msg.type === 'AIRDROP') {
        if (!stored) throw new Error('No wallet found.');
        const network = await currentNetwork();
        if (network !== 'devnet') throw new Error('Airdrop is only available on Devnet.');

        const requested = Number(msg.lamports);
        const lamports = Number.isFinite(requested) && requested > 0
          ? Math.min(requested, 2 * LAMPORTS_PER_SOL)
          : LAMPORTS_PER_SOL;

        const endpoint = endpoints['solana:devnet'];
        const connection = new Connection(endpoint, 'confirmed');

        let signature;
        try {
          signature = await connection.requestAirdrop(new PublicKey(stored.address), lamports);
        } catch (error) {
          // 空投失败绝大多数是频率/额度限制，直接说明原因，别只抛一句 RPC 报错
          throw new Error(
            `Airdrop failed: ${error?.message || error}. ` +
            'Devnet 空投有频率和额度限制，等一两分钟再试，或改用 https://faucet.solana.com'
          );
        }

        console.log('[Wallet] Airdrop requested:', signature);
        return sendResponse({ok:true, signature, lamports});
      }

      if (msg.type === 'WALLET') {
        const kp = await getUnlocked();
        if (!kp) throw new Error('Wallet is locked. Open the extension and unlock it.');

        if (msg.action === 'getAccount') {
          return sendResponse({
            ok:true,
            address: kp.publicKey.toBase58(),
            publicKey: b64(kp.publicKey.toBytes())
          });
        }

        if (msg.action === 'signTransaction') {
          const { signed, kind, input, length } = signRawTransaction(
            bytes(msg.transaction), kp, { requireAllSignatures: false }
          );
          console.log(
            `[Wallet] signTransaction ok: ${input} (${length}B) -> ${kind} (${signed.length}B)`
          );
          return sendResponse({ok:true, signedTransaction:b64(signed)});
        }

        if (msg.action === 'signAndSendTransaction') {
          const { signed, kind, input, length } = signRawTransaction(
            bytes(msg.transaction), kp
          );

          console.log(
            `[Wallet] signAndSendTransaction: ${input} (${length}B) -> ${kind}`
          );

          const endpoint = await resolveEndpoint(msg.chain);
          const connection = new Connection(endpoint, 'confirmed');

          let signature;
          try {
            signature = await connection.sendRawTransaction(
              signed,
              sendOptions(msg.options)
            );
          } catch (error) {
            // 把 RPC 的失败原因（含 simulate 日志）带回页面，否则只能看到一句笼统的报错
            const logs = Array.isArray(error?.logs) && error.logs.length
              ? `\nlogs:\n${error.logs.join('\n')}`
              : '';
            throw new Error(
              `Transaction rejected by ${endpoint}: ${error?.message || error}${logs}`
            );
          }

          console.log('[Wallet] Transaction sent:', signature);

          return sendResponse({ ok: true, signature: b64(bs58.decode(signature)) });
        }

        throw new Error('Unsupported wallet action.');
      }

      sendResponse({ok:false,error:'Unknown message'});
    } catch (e) {
      sendResponse({ok:false,error:e.message || String(e)});
    }
  })();
  return true;
});
