// 内容脚本：把页面主世界里的 wallet.js 和扩展后台连起来
const ALLOWED_ACTIONS = new Set(['getAccount', 'signTransaction', 'signAndSendTransaction']);

const script = document.createElement('script');
script.src = chrome.runtime.getURL('assets/wallet.js');
script.type = 'module';
script.onload = () => script.remove();
script.onerror = () => script.remove();
(document.head || document.documentElement).appendChild(script);

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== 'minimal-solana-wallet') return;

  const id = msg.id;
  let response;

  try {
    if (!ALLOWED_ACTIONS.has(msg.action)) {
      throw new Error(`Unsupported wallet action: ${msg.action}`);
    }

    response = await chrome.runtime.sendMessage({
      type: 'WALLET',
      action: msg.action,
      transaction: msg.transaction,
      chain: msg.chain,
      options: msg.options
    });

    // service worker 被回收等情况会拿不到响应，必须回一条消息，否则页面 Promise 永久挂起
    if (!response) throw new Error('No response from the wallet extension.');
  } catch (error) {
    response = { ok: false, error: error?.message || String(error) };
  }

  window.postMessage({
    source: 'minimal-solana-wallet-response',
    id,
    ...response
  }, '*');
});
