import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './popup.css';

const LAMPORTS_PER_SOL = 1000000000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 顶部工具条：品牌 + 状态药丸 + 两个「换个地方打开」的入口。
 *
 * 侧边栏本身已经常驻了，但有时想要更大的一块地方（看长地址、粘私钥），
 * 或者想把钱包单独扔到第二块屏幕上 —— 这两个按钮就是干这个的。
 * 独立窗口 / 新标签页 / 侧边栏共用同一个 service worker 和同一份 storage，
 * 所以余额、解锁态、网络选择都是同一份数据，不会出现两个「钱包」。
 *
 * @param {boolean} [unlocked] 传了才显示状态药丸（还没有钱包时无从谈起）
 */
function Header({ unlocked }) {
  async function ask(message) {
    try {
      if (typeof chrome === 'undefined') return;   // npm run dev 调样式时点了不报错
      const r = await chrome.runtime.sendMessage(message);
      if (!r?.ok) console.warn(`[Wallet] ${message.type} 失败:`, r?.error);
    } catch (error) {
      console.warn(`[Wallet] ${message.type} 失败:`, error?.message || error);
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">◎</span>
        <h2>Minimal Solana Wallet</h2>
      </div>
      <div className="topbar-actions">
        {unlocked !== undefined && (
          <span className={unlocked ? 'pill on' : 'pill off'}>{unlocked ? '已解锁' : '已锁定'}</span>
        )}
        {/* 去重逻辑在 background：已经开着就聚焦，不会点一次多开一个窗口 */}
        <button type="button" className="btn mini" title="在独立窗口中打开（失去焦点也不会关闭）"
                onClick={() => ask({ type: 'OPEN_WINDOW' })}>⧉ 窗口</button>
        <button type="button" className="btn mini" title="在新标签页中打开"
                onClick={() => ask({ type: 'OPEN_TAB' })}>↗ 标签页</button>
      </div>
    </header>
  );
}

function App() {
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secret, setSecret] = useState('');
  const [importKey, setImportKey] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [network, setNetwork] = useState('devnet');
  const [balance, setBalance] = useState(null);
  const [busy, setBusy] = useState('');
  const [armingReset, setArmingReset] = useState(false);
  const [message, setMessage] = useState('');

  // npm run dev 打开的是普通网页，没有 chrome.*：这时停在「新建钱包」界面，方便调样式。
  // 真实扩展（侧边栏 / 独立窗口 / 标签页）里 chrome 一定存在，不会走到这个分支。
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime;

  async function refresh() {
    if (!hasChrome) return;

    const r = await chrome.runtime.sendMessage({ type: 'STATE' });
    if (r.ok) setInfo(r);

    const n = await chrome.storage.local.get('network');
    setNetwork(n.network || 'devnet');

    if (r.ok && r.exists) {
      const b = await chrome.runtime.sendMessage({ type: 'BALANCE' });
      // 余额读取失败只影响余额那一行，不要覆盖掉用户刚做的操作的结果提示
      setBalance(b.ok ? b.lamports : null);
    } else {
      setBalance(null);
    }
  }

  useEffect(() => { refresh(); }, []);

  // 侧边栏、独立窗口、标签页可能同时开着：任何一边解锁 / 换网络 / 重置都会写 storage，
  // 其余几边靠 onChanged 跟着刷新，否则会出现「这边显示 Locked、那边显示 Unlocked」。
  useEffect(() => {
    if (!hasChrome) return;

    let timer = null;
    const onChanged = (_changes, area) => {
      if (area !== 'local' && area !== 'session') return;
      clearTimeout(timer);
      timer = setTimeout(refresh, 120);   // 合并同一次操作里的多次写入，避免连打几个 RPC
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  // 统一包装：显示进行中状态，并把后台报错落到 message 上
  async function run(label, fn) {
    setBusy(label);
    try {
      return await fn();
    } catch (error) {
      const text = error?.message || String(error);
      setMessage(text);
      return { ok: false, error: text };
    } finally {
      setBusy('');
    }
  }

  async function create() {
    if (password.length < 8) return setMessage('密码至少 8 位。');
    if (password !== confirm) return setMessage('两次密码不一致。');
    const r = await run('create', () => chrome.runtime.sendMessage({ type: 'CREATE', password }));
    setMessage(r.ok ? '钱包已在本地创建。地址固定不变，重装扩展后用「导入私钥」即可找回。' : r.error);
    if (r.ok) { setPassword(''); setConfirm(''); await refresh(); }
  }

  // 找回原账号：导入之前导出的私钥，地址和余额都还在，不用重新空投
  async function importWallet() {
    if (!importKey.trim()) return setMessage('请粘贴私钥。');
    if (importPassword.length < 8) return setMessage('密码至少 8 位。');
    const r = await run('import', () => chrome.runtime.sendMessage({
      type: 'IMPORT',
      secretKey: importKey.trim(),
      password: importPassword
    }));
    setMessage(r.ok ? `已导入账号 ${r.address}` : r.error);
    if (r.ok) { setImportKey(''); setImportPassword(''); await refresh(); }
  }

  async function unlock() {
    const r = await run('unlock', () => chrome.runtime.sendMessage({ type: 'UNLOCK', password }));
    setMessage(r.ok ? '钱包已解锁。' : r.error);
    if (r.ok) { setPassword(''); await refresh(); }
  }

  async function lock() {
    await run('lock', () => chrome.runtime.sendMessage({ type: 'LOCK' }));
    setSecret('');
    await refresh();
  }

  async function exportSecret() {
    const r = await run('export', () => chrome.runtime.sendMessage({ type: 'EXPORT' }));
    setSecret(r.ok ? r.secretKey : '');
    setMessage(r.ok ? '这是唯一的备份：重装扩展后用它导入，就能拿回同一个地址和余额。' : r.error);
  }

  async function airdrop() {
    setMessage('正在请求 Devnet 空投…');
    const r = await run('airdrop', () => chrome.runtime.sendMessage({ type: 'AIRDROP' }));
    if (!r.ok) return setMessage(r.error);
    setMessage(`已请求空投 ${r.lamports / LAMPORTS_PER_SOL} SOL，等待确认…`);
    await sleep(3000);
    await refresh();
    setMessage(`空投已提交：${r.signature}`);
  }

  async function changeNetwork(e) {
    const value = e.target.value;
    setNetwork(value);
    setBalance(null);
    await chrome.storage.local.set({ network: value });
    await refresh();
  }

  // 二次确认：第一次点击只是提示，第二次才真的清空 vault
  async function reset() {
    if (!armingReset) {
      setArmingReset(true);
      setMessage('再点一次「确认重置」将永久删除本地账号。如果还没备份，请先 Export Secret Key。');
      return;
    }
    const r = await run('reset', () => chrome.runtime.sendMessage({ type: 'RESET', confirm: true }));
    setArmingReset(false);
    setSecret('');
    setMessage(r.ok ? '本地账号已删除。可以用私钥重新导入。' : r.error);
    await refresh();
  }

  if (!info?.exists) {
    return <main>
      <Header />

      <section className="card">
        <span className="card-title">新建钱包</span>
        <p className="hint">纯本地开发钱包：不创建用户账号，不连接后台 API。</p>
        <div className="field">
          <label>密码（≥8 位）</label>
          <input type="password" placeholder="设置一个本地密码" value={password} onChange={e=>setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label>确认密码</label>
          <input type="password" placeholder="再输一次" value={confirm} onChange={e=>setConfirm(e.target.value)} />
        </div>
        <button className="btn primary block" onClick={create} disabled={!!busy}>
          {busy === 'create' ? '创建中…' : 'Create Wallet'}
        </button>
      </section>

      <section className="card">
        <span className="card-title">导入已有私钥</span>
        <p className="hint">找回原来的地址和余额，不用重新空投。</p>
        <div className="field">
          <label>私钥</label>
          <textarea rows={3} placeholder="base58 私钥，或 [1,2,3,…] 形式的 JSON 数组"
                    value={importKey} onChange={e=>setImportKey(e.target.value)} />
        </div>
        <div className="field">
          <label>新密码（≥8 位）</label>
          <input type="password" placeholder="给这个钱包设一个本地密码" value={importPassword} onChange={e=>setImportPassword(e.target.value)} />
        </div>
        <button className="btn primary block" onClick={importWallet} disabled={!!busy}>
          {busy === 'import' ? '导入中…' : 'Import Secret Key'}
        </button>
      </section>

      {message && <p className="msg">{message}</p>}
      <p className="hint">这是开发版。真实资产请勿使用。</p>
    </main>;
  }

  return <main>
    <Header unlocked={info.unlocked} />

    <section className="card">
      <div className="card-head">
        <span className="card-title">账户</span>
        <select value={network} onChange={changeNetwork} title="选择网络">
          <option value="devnet">Devnet</option>
          <option value="mainnet">Mainnet</option>
        </select>
      </div>

      <div className="balance">
        <span className="balance-value">
          {balance === null ? '—' : (balance / LAMPORTS_PER_SOL).toFixed(4)}
        </span>
        <span className="balance-unit">SOL</span>
        <button className="btn mini" onClick={refresh} disabled={!!busy} title="重新读取余额">刷新</button>
      </div>
      {balance === null && <p className="hint">余额读取失败（RPC 超时或网络不通），可以再点「刷新」。</p>}

      <div className="field">
        <label>Address</label>
        <code className="address">{info.address}</code>
      </div>
    </section>

    {network === 'devnet' && (
      <section className="card">
        <span className="card-title">Devnet 测试币</span>
        <button className="btn primary block" onClick={airdrop} disabled={!!busy}>
          {busy === 'airdrop' ? '请求中…' : 'Airdrop 1 SOL'}
        </button>
        <p className="hint">
          空投有频率和额度限制，失败时可以改用
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer"> faucet.solana.com</a>。
        </p>
      </section>
    )}

    {!info.unlocked && (
      <section className="card">
        <span className="card-title">解锁</span>
        <input type="password" placeholder="密码" value={password} onChange={e=>setPassword(e.target.value)} />
        <button className="btn primary block" onClick={unlock} disabled={!!busy}>Unlock</button>
      </section>
    )}

    {info.unlocked && (
      <section className="card">
        <span className="card-title">私钥</span>
        <div className="actions">
          <button className="btn primary" onClick={exportSecret} disabled={!!busy}>Export Secret Key</button>
          <button className="btn" onClick={lock} disabled={!!busy}>Lock</button>
        </div>
        {secret && <>
          <textarea readOnly className="secret" value={secret} rows={4} />
          <p className="hint">这是唯一的备份，请立刻复制保存 —— 关掉界面就不会再显示了。</p>
        </>}
      </section>
    )}

    <section className="card danger-zone">
      <span className="card-title">危险操作</span>
      <button className="btn danger block" onClick={reset} disabled={!!busy}>
        {armingReset ? '确认重置（账号将永久丢失）' : 'Reset wallet'}
      </button>
      <p className="hint">重置会清空本地 vault。没备份私钥的话，这个地址里的币就再也拿不回来了。</p>
    </section>

    {message && <p className="msg">{message}</p>}
    <p className="hint">私钥仅保存在扩展本地。地址固定不变，没有找回密码的服务器；备份私钥后，重装扩展也能导入同一个账号。</p>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
