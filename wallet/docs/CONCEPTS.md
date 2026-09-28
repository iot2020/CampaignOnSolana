# 概念扫盲：这个项目里到底在干什么

写给第一次接触「浏览器扩展 + Solana 钱包」的人。每一节都对应本仓库的真实代码，
读完可以直接去翻对应文件验证。文档里出现的所有字节数据都是实测出来的，不是编的。

建议阅读顺序：第 0 节 → 第 6 节（案例）→ 其余按需查。
如果你只想改代码，看完第 0 节和第 8 节就够动手了。

## 目录

- [0. 五分钟看懂整体结构](#0-五分钟看懂整体结构)
- [1. Solana 侧：账户、密钥、交易](#1-solana-侧账户密钥交易)
- [2. 浏览器扩展 MV3：三个世界](#2-浏览器扩展-mv3三个世界)
- [3. Wallet Standard：DApp 怎么发现钱包](#3-wallet-standarddapp-怎么发现钱包)
- [4. 密码学：私钥怎么存在本地](#4-密码学私钥怎么存在本地)
- [5. 工程：构建与测试](#5-工程构建与测试)
- [6. 案例一：Reached end of buffer unexpectedly](#6-案例一reached-end-of-buffer-unexpectedly)
- [7. 案例二：账号"消失"，每次都要重新空投](#7-案例二账号消失每次都要重新空投)
- [8. 怎么调试](#8-怎么调试)
- [9. 术语速查表](#9-术语速查表)
- [10. 阅读顺序、练习与延伸阅读](#10-建议的阅读顺序与动手练习)

---

## 0. 五分钟看懂整体结构

你在 DApp 页面上点一次 "Donate"，数据要走完这么一圈：

```
DApp 页面 (MAIN world)
   │  Wallet Standard 调用 wallet.features[...].signAndSendTransaction()
   ▼
assets/wallet.js      ← src/wallet.js       注入页面的"钱包代理"，只转发不持钥
   │  window.postMessage
   ▼
assets/content.js     ← src/content.js      内容脚本 (ISOLATED world)，唯一的桥
   │  chrome.runtime.sendMessage
   ▼
assets/background.js  ← src/background.js   MV3 service worker：持钥、签名、发交易
   │  HTTPS JSON-RPC (getLatestBlockhash / sendTransaction)
   ▼
Solana 集群 (devnet / mainnet)
```

**为什么要绕这么多层？** 因为浏览器把这三块严格隔离：

- 页面里的 JS 看不到 `chrome.*` API（否则任何网站都能操作你的扩展）；
- 内容脚本能用 `chrome.*`，但和页面 JS **不共享变量**（不同"世界"，见第 2 节）；
- 只有 service worker 适合长期持有密钥并发网络请求。

对应到文件：

| 文件 | 跑在哪 | 职责 |
| --- | --- | --- |
| `src/wallet.js` | 页面 MAIN world | `registerWallet()` 向 DApp 声明"我是个 Solana 钱包" |
| `src/content.js` | ISOLATED world | 注入 wallet.js、转发消息、action 白名单 |
| `src/background.js` | service worker | 密钥保管、签名、RPC、余额、空投 |
| `src/popup.jsx` | 扩展侧边栏 / 独立窗口 (React) | 创建 / 解锁 / 导出 / 导入 / 余额 / 空投 / 重置 |
| `src/tx.js` | service worker（纯函数） | 解析并签名 DApp 传来的字节 |
| `src/keys.js` | service worker（纯函数） | 解析用户粘贴的私钥 |

注意 `src/tx.js` 和 `src/keys.js` **故意不 import 任何 `chrome.*`**，所以能直接在
Node 里跑测试（`npm test`）。这是个值得学的工程习惯：把最容易出错的纯逻辑从运行
环境里剥出来，出 bug 时能在命令行里一秒复现，不用反复重载扩展点按钮。

---

## 1. Solana 侧：账户、密钥、交易

### 1.1 一切皆账户

Solana 没有"转账函数"这种特殊语法，链上只有一种东西：**账户**。每个账户有：

- `address`：32 字节公钥（你看到的地址就是它的 base58 编码）
- `lamports`：余额。1 SOL = 1,000,000,000 lamports
- `owner`：哪个"程序"（program，即合约）有权改它的 data
- `data`：任意字节
- `executable`：是不是个程序

普通钱包账户和合约账户**结构完全一样**，区别只是 `executable` 和 `owner`。
转账这件事由一个内置程序完成，它的地址是全 0 的 32 字节，base58 编码后长这样：

```
11111111111111111111111111111111      ← System Program（32 个 "1"）
```

这不是巧合也不是乱码：base58 里 `1` 就代表字节 `0x00`。`src/tx.js` 里
`SystemProgram.programId.toBase58()` 返回的正是这一串。

### 1.2 密钥：seed → secret key → public key

Solana 用 **ed25519** 签名，三个长度必须记牢：

```
seed        32 字节   真正的"随机源"，只有它需要保密
  │  SHA-512 派生
  ▼
secret key  64 字节 = seed(32) ‖ public key(32)     ← 导出的"私钥"是这个
  ▼
public key  32 字节   = 地址
```

**关键点：secret key 是 64 字节，不是 32。** 它是 seed 和公钥拼在一起。
这就是为什么 `src/keys.js` 只接受 64 字节：

```js
// src/keys.js
if (length === 32) {
  throw new Error('That is 32 bytes — a public key or a seed, not a secret key. ...');
}
```

如果你把 32 字节的 seed 当成 secret key 喂给 `Keypair.fromSecretKey()`，
它要么报错，要么（在某些库里）被当成 seed 派生出**另一个**密钥对。后者更可怕：
你以为找回了旧账号，实际拿到一个新地址，然后把钱打进新地址。所以这里选择
直接报错，绝不猜。

编码方式：

- **base58**：地址和私钥的常见文本形式。字母表去掉了 `0 O I l`（容易和 `o 1` 混淆）。
  32 字节 → 32~44 个字符；64 字节 → 88 个字符左右。
- **JSON 数组**：`[1,2,3,...]`，solana-keygen 生成的 `id.json` 就是这个格式。
  同一个私钥的两种写法，`src/keys.js` 都支持。
- **base64**：本项目跨进程传字节时用（见 3.4）。

### 1.3 交易的结构

一笔**完整交易**（serialized transaction）= 签名 + 消息：

```
┌──────────────────┬──────────────────────┬─────────────────────────┐
│ compact-u16      │ 64 字节 × N          │ message                 │
│ 签名数量 N        │ 签名                 │                         │
└──────────────────┴──────────────────────┴─────────────────────────┘
```

`message` 本身长这样：

```
┌─────────┬──────────────────┬──────────────────┬───────────────┬────────────────────┐
│ header  │ compact-u16      │ 32 字节 × M      │ recentBlockhash│ compact-u16       │
│ 3 字节   │ 账户数量 M        │ 账户表           │ 32 字节        │ 指令数量 + 指令     │
└─────────┴──────────────────┴──────────────────┴───────────────┴────────────────────┘
   │
   └─ numRequiredSignatures / numReadonlySignedAccounts / numReadonlyUnsignedAccounts
```

每条指令（instruction）= `programIdIndex(1B)` + `账户索引列表` + `data`，
里面存的是**索引**而不是完整地址 —— 账户表去重后，指令只引用下标，省空间。

实测对比（同一条 transfer 指令）：

```
full tx  len 215  head [1, 160, 123, 79]     ← 1 个签名，后面 64 字节是签名
message  len 150  head [1,   0,   1,  3]     ← header: 1 个签名者, 0 只读签名者, 1 只读非签名者, 3 个账户
差值 = 65 = 1 (compact-u16) + 64 (签名)
```

两者的第一个字节**都是 1**，含义却完全不同：完整交易里它是"签名数量"，
message 里它是"需要几个签名者"。这正是第 6 节那个 bug 的根源。

### 1.4 compact-u16：变长整数（必须搞懂）

Solana 序列化里所有"数量"字段都用 **compact-u16**（也叫 shortvec）：每个字节
低 7 位存数据，最高位是"还有后续字节"的标志。

```
数值 0..127        → 1 字节，例如 3        → [0x03]
数值 128..16383    → 2 字节，例如 200      → [0xC8, 0x01]   (200 = 0b1_1001000)
数值 16384..       → 3 字节
```

它的意义是省空间（大多数数量都小于 128，只占 1 字节）。它的代价是：**你无法通过
"每 N 字节一个字段"去跳读，必须逐字节解码才知道这个字段有多长。**

一旦解码错位，后面所有字节全部错乱 —— 这就是第 6 节那个 bug 的机制。

### 1.5 签名签的是 message，不是整个交易

ed25519 签名的输入是 **message 的字节**。这带来一个重要结论：

> 只要拿到 message，就能签出合法的完整交易；签名本身可以后补。

所以 DApp 完全可以只把 message 交给钱包签名，钱包签完再把 64 字节签名拼回前面。
`src/tx.js` 的 `signRawTransaction()` 正是这么做的：

```js
// src/tx.js —— 两条路径，最终都归到 VersionedTransaction 上签
const message = VersionedMessage.deserialize(raw);
const tx = new VersionedTransaction(message);   // 签名位先是占位的零
tx.sign([keypair]);                             // 这里签的是 message 字节
const signed = tx.serialize();                  // 输出完整交易
```

### 1.6 legacy 与 v0（versioned transaction）

message 有两种格式：

| | 首字节 | 说明 |
| --- | --- | --- |
| **legacy** | `numRequiredSignatures`（小整数，最高位=0） | 老格式，账户表必须写全 |
| **v0** | `0x80 \| 0`（最高位=1） | 支持 Address Lookup Table，用一张链上表引用地址，交易更小 |

区分办法：**首字节最高位是 1 → versioned；是 0 → legacy**。

但注意，"完整交易"的首字节是签名数量，通常也是 0~2 这种小整数（最高位=0）。
所以「首字节最高位=0」这个信息**无法区分** legacy message 和完整交易 —— 两者都长得
像。`src/tx.js` 因此采用"按首字节猜一个先试，另一种兜底"的策略：

```js
// src/tx.js —— 首字节最高位为 1 就先当 message，否则先当完整交易
const attempts = startsWithVersionPrefix(bytes)
  ? [['message', signSerializedMessage], ['transaction', signSerializedTransaction]]
  : [['transaction', signSerializedTransaction], ['message', signSerializedMessage]];

for (const [label, attempt] of attempts) {
  try {
    return { ...attempt(bytes, keypair, requireAllSignatures), input: label, length: bytes.length };
  } catch (error) {
    failures.push(`${label}: ${error?.message || error}`);
  }
}
// 两种都失败时，把两次的原始错误都带上，而不是只抛最后一句
throw new Error(`Unable to parse the transaction sent by the dApp (${preview(bytes)}). Tried ${failures.join(' | ')}`);
```

本项目在 `src/wallet.js` 里声明支持两种版本：
`supportedTransactionVersions: ['legacy', 0]`。DApp 看到这个声明，才敢发 v0 交易过来。

### 1.7 recentBlockhash、交易过期、1232 字节

- **recentBlockhash**：message 里那 32 字节，取自最近某个区块的哈希。它的作用是
  防重放 + 限定有效期：大约 **150 个 slot（60~90 秒）** 后过期，之后广播会报
  `Blockhash not found`。所以钱包必须**现取现签**，不能缓存。
- **1232 字节**：Solana 用 UDP 转发交易，单个包上限 1232 字节（`PACKET_DATA_SIZE`）。
  超过就必然失败，报 `Transaction too large`。这也是 v0 + ALT 存在的理由。

### 1.8 RPC、commitment、preflight

钱包和链之间只有 **JSON-RPC over HTTPS**。本项目用到：

| 方法 | 用途 | 代码位置 |
| --- | --- | --- |
| `getLatestBlockhash` | DApp 取 blockhash（钱包侧不取） | — |
| `getBalance` | popup 显示余额 | `background.js` `BALANCE` |
| `requestAirdrop` | devnet 领测试币 | `background.js` `AIRDROP` |
| `sendTransaction` | 广播签名后的交易 | `background.js` `signAndSendTransaction` |

**commitment（确认级别）** 表示"这个状态有多可信"：

```
processed  → 当前验证者已处理，可能回滚
confirmed  → 超多数投票通过，基本不会回滚   ← 本项目用这个
finalized  → 已最终确定
```

**preflight**：`sendTransaction` 默认会先在本地模拟一次交易（simulate），
模拟失败就不广播，直接把错误返回。这很有用 —— 你能在**花掉手续费之前**知道
"余额不足""账户不存在"。失败时 RPC 会带 `logs` 数组，`src/background.js` 特意把它
拼进错误消息里：

```js
// src/background.js
const logs = Array.isArray(error?.logs) && error.logs.length
  ? `\nlogs:\n${error.logs.join('\n')}` : '';
throw new Error(`Transaction rejected by ${endpoint}: ${error?.message || error}${logs}`);
```

不这么做的话，你只会看到一句笼统的 `failed to send transaction`，完全不知道原因。

### 1.9 devnet 与空投

三个网络：`mainnet-beta`（真钱）、`devnet`（测试，币无价值）、
`testnet`（性能测试）。本项目默认 devnet，端点写死在 `src/background.js` 的
`endpoints` 里。

devnet 有个 **faucet**，可以给任意地址免费打币，对应 RPC 方法 `requestAirdrop`。
它有频率和额度限制，被限流时 popup 会提示改用 <https://faucet.solana.com>。
`mainnet` 没有 faucet —— 所以第 7 节讲的"地址固定"在 mainnet 上是真金白银的事。

---

## 2. 浏览器扩展 MV3：三个世界

### 2.1 MAIN / ISOLATED / service worker

同一个网页里其实跑着两套 JS，互相看不见对方的变量：

```
┌── 页面进程 ────────────────────────────────────────────┐
│  MAIN world      DApp 的 JS、你的 wallet.js            │  有 DOM，没有 chrome.*
│  ISOLATED world  content.js                            │  有 DOM，有 chrome.*（部分）
└────────────────────────────────────────────────────────┘
┌── 扩展进程 ────────────────────────────────────────────┐
│  service worker  background.js                          │  没有 DOM，有全部 chrome.*
│  side panel      popup.html + popup.js                  │  有 DOM，有全部 chrome.*
└────────────────────────────────────────────────────────┘
```

- **MAIN world**：DApp 的代码所在。它能看到 `window`，但 `chrome.runtime` 是
  `undefined`。所以 `wallet.js` 必须注入到这里 —— DApp 只能和它对话。
- **ISOLATED world**：内容脚本所在。共享同一个 DOM，但 JS 变量完全隔离。
  这是安全边界：即使页面被 XSS，攻击者也拿不到 `chrome.*`。
- 两者通信只能用 `window.postMessage`（走 DOM 事件，天然跨世界）。

`src/wallet.js` 跑在 MAIN world，所以它**没有** `chrome.*`，只能 postMessage 出去，
由 `src/content.js` 转成 `chrome.runtime.sendMessage`。这就是那个"看起来很绕"的链条
存在的原因 —— 它不是设计冗余，是浏览器强制的。

### 2.2 service worker 会被回收

MV3 的 background 不再是常驻页面，而是 **service worker**：空闲约 30 秒就被 Chrome
杀掉，所有内存变量清零，下次有消息再重新启动。

所以 `src/background.js` 用两级缓存保存"已解锁"状态：

```js
let unlocked = null;                       // ① 内存缓存，进程活着时最快

async function saveUnlocked(kp) {
  unlocked = kp;
  await chrome.storage.session.set({ [SESSION_SECRET]: b64(kp.secretKey) });   // ② 落盘
}

async function getUnlocked() {
  if (unlocked) return unlocked;           // 内存命中
  const encoded = (await chrome.storage.session.get(SESSION_SECRET))[SESSION_SECRET];
  if (!encoded) return null;
  const kp = Keypair.fromSecretKey(bytes(encoded));
  const stored = await getStore();
  // 还要和 vault 里的地址对一遍，防止 session 里残留别的账号
  if (stored && kp.publicKey.toBase58() === stored.address) { unlocked = kp; return kp; }
  await chrome.storage.session.remove(SESSION_SECRET);
  return null;
}
```

**教训：MV3 扩展里任何"存在内存里的状态"都要假设它会消失。**

### 2.3 chrome.storage 的三个抽屉

| API | 生命周期 | 本项目用途 |
| --- | --- | --- |
| `storage.local` | 永久（直到卸载/清除） | 加密后的 vault、选择的网络 |
| `storage.session` | 浏览器关闭即清，且默认只有扩展自己能读 | 解锁态（明文私钥） |
| `storage.sync` | 跟随 Google 账号同步，100KB 级 | 未使用（私钥不该同步到云端） |

三者都**按扩展 ID 隔离**。记住这句话，第 7 节的坑就是它。

### 2.4 扩展 ID 是怎么来的

```
打包扩展 (.crx)   → 由签名私钥决定，永远不变
未打包 (开发中)   → 由「加载路径」的哈希决定；除非 manifest 里写了 "key"
```

manifest 的 `key` 字段是一个 base64 的公钥。写上它，Chrome 就用这个公钥算 ID，
**和路径无关**。本项目 `public/manifest.json` 第 6 行就是这么做的，ID 固定为：

```
gbkhjkllidmdjheioadjnpebiohlhfoc
```

不写 `key` 的话：删了重装、把 `dist/` 复制到别处、换个目录名 → ID 变 →
`storage.local` 变成一片空白 → 你的钱包"消失"了。

### 2.5 注入脚本与 web_accessible_resources

`src/content.js` 开头这几行是标准的"往 MAIN world 投脚本"手法：

```js
const script = document.createElement('script');
script.src = chrome.runtime.getURL('assets/wallet.js');   // chrome-extension://<ID>/assets/wallet.js
script.type = 'module';
script.onload = () => script.remove();                     // 注入完就把标签删掉，不留痕
(document.head || document.documentElement).appendChild(script);
```

`chrome.runtime.getURL()` 返回的资源默认**页面读不到**（会被 CORS 拦），
必须在 manifest 里声明白名单：

```json
"web_accessible_resources": [{
  "resources": ["assets/wallet.js", "assets/*.js"],
  "matches": ["http://*/*", "https://*/*"]
}]
```

manifest 里的 `"run_at": "document_start"` 也很重要：必须在 DApp 自己的 JS 之前
注入，否则 DApp 调 `getWallets()` 时还看不到你，表现为"钱包连不上"。

### 2.6 消息传递：必须 return true

`chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {...})` 有个坑：
监听器**同步返回后**，消息通道就关闭了。而本项目所有处理都是 `async`，
所以 `src/background.js` 用的是「IIFE + 末尾 `return true`」的写法：

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try { /* ... sendResponse({ok:true, ...}) ... */ }
    catch (e) { sendResponse({ ok:false, error: e.message || String(e) }); }
  })();
  return true;        // ← 告诉 Chrome：我要异步响应，先别关通道
});
```

漏掉 `return true`，你会得到一个 `undefined` 响应或
"The message port closed before a response was received."。

同理，`src/content.js` 里这一行也是必需的：

```js
if (!response) throw new Error('No response from the wallet extension.');
```

service worker 正好被回收/重启失败时会返回 `undefined`；不检查的话，页面那边的
Promise 就**永久挂起**，用户看到的是"点了没反应"，比报错难查得多。

### 2.7 popup 失焦就关，侧边栏不会

这是界面形态上最容易踩的一个"不是 bug 的 bug"。

`manifest.json` 里如果写：

```json
"action": { "default_popup": "popup.html" }
```

点图标得到的是 **browser action popup**：一小块浮在工具栏下面的临时窗口。它由
Chrome 自己托管，规则是硬性的 —— **失去焦点即销毁**：

- 点了页面任何地方、切了标签页、切到别的应用、开了 DevTools → 整个文档被销毁；
- `window.addEventListener('blur', e => e.preventDefault())` 无效，没有任何 API 能拦住；
- 再次打开是一个**全新的页面**：React 状态、滚动位置、填了一半的表单全部归零。

所以它只适合"点一下、看一眼、马上关"。钱包这种要长时间停着、一边操作 DApp
一边看地址和余额的场景，popup 的体验非常差。

Phantom / Solflare 那种"常驻在浏览器边上"的效果，用的是 **Side Panel API**
（`chrome.sidePanel`，Chrome 114+）。侧边栏是浏览器窗口里一块真正的区域：
失焦不关、切标签页不关、跳页面不关、宽度还能拖。本项目现在就是这么做的：

```json
"action":      { "default_title": "Minimal Solana Wallet" },   // 注意：没有 default_popup
"side_panel":  { "default_path": "popup.html" },
"permissions": ["sidePanel", "storage"],
"minimum_chrome_version": "114"
```

```js
// background.js：点工具栏图标 → 开侧边栏（而不是弹窗）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

四个关键点：

1. **`default_popup` 必须删掉**。只要它还在，点图标就永远是弹窗，
   `openPanelOnActionClick` 不生效，`action.onClicked` 也不会触发。
2. **`minimum_chrome_version` 要写**。老 Chrome 不认识 `sidePanel` 这个权限名，
   会直接报 `Permission 'sidePanel' is unknown` 而拒绝加载；写明最低版本，
   至少错误信息是能看懂的。
3. **宿主变了，CSS 不能再写死宽度**。原来 `body { width: 340px }` 是弹窗尺寸，
   侧边栏宽度用户能拖，所以改成填满宿主 + `max-width: 560px` 居中（`src/popup.css`）。
4. **同一份 UI 可能同时开着好几份**（侧边栏 + 独立窗口 + 标签页）。它们共用一个
   service worker、一份 storage，但 React 状态各自独立，所以 `popup.jsx` 挂了
   `chrome.storage.onChanged` → `refresh()`：一边解锁，另一边立刻跟上。

除了侧边栏，`background.js` 还提供两种形态：

| 消息 | 实现 | 特点 |
| --- | --- | --- |
| `OPEN_WINDOW` | `chrome.windows.create({ type:'popup' })` | 失焦不关的小窗，可以拖到第二块屏幕；已开着就聚焦，不会点一次多开一个 |
| `OPEN_TAB` | `chrome.tabs.create()` | 地方最大，适合粘长私钥、看完整地址 |

独立窗口的 id 存在 `chrome.storage.session`（不是内存变量）—— 因为第 2.2 节说过
service worker 会被回收，内存里的 `windowId` 靠不住；同时监听
`chrome.windows.onRemoved` 清掉失效的 id。

---

## 3. Wallet Standard：DApp 怎么发现钱包

### 3.1 它解决什么问题

在 Wallet Standard 之前，每个钱包都往 `window` 上挂自己的私有对象
（`window.phantom`、`window.solflare`……），每个 DApp 都要为每个钱包写一遍适配代码，
N×M 的组合爆炸。

Wallet Standard 把它标准化成两件事：

1. **钱包**调 `registerWallet(walletObject)` 宣告自己的存在和能力；
2. **DApp**（通常通过 `@solana/wallet-adapter`）调 `getWallets()` 拿到列表。

本项目只做第 1 件事 —— 第 2 件是 DApp 侧的库干的，所以任何用标准
wallet-adapter 的 DApp 都能自动发现这个钱包。

### 3.2 注册

```js
// src/wallet.js
import { registerWallet } from '@wallet-standard/core';
registerWallet(wallet);
```

`registerWallet` 内部就是往 `window` 上派发一个 `wallets:register` 事件。
这也是为什么 `wallet.js` 必须**早于** DApp 的脚本执行（见 2.5 的 `document_start`）：
如果你注册得太晚，DApp 已经 `getWallets()` 完了，就不会再看到你。

### 3.3 features = 能力协商

钱包对象里最关键的是 `features`，它同时是"我能做什么"的声明和实现：

```js
// src/wallet.js
const CHAINS = ['solana:devnet', 'solana:mainnet'];
const TRANSACTION_VERSIONS = ['legacy', 0];

const wallet = {
  name: 'Minimal Solana Wallet',
  icon: ICON,                                  // data: URI 的 SVG，DApp 弹窗里显示
  chains: CHAINS,
  get accounts() { return accounts; },          // 连接前是空数组
  features: {
    'standard:connect':            { version:'1.0.0', connect: async () => {...} },
    'standard:disconnect':         { version:'1.0.0', disconnect: async () => {...} },
    'solana:signTransaction':      { version:'1.0.0', supportedTransactionVersions: TRANSACTION_VERSIONS, signTransaction: ... },
    'solana:signAndSendTransaction':{ version:'1.0.0', supportedTransactionVersions: TRANSACTION_VERSIONS, signAndSendTransaction: ... }
  }
};
```

几个新手容易忽略的点：

- **`supportedTransactionVersions` 必须声明**。不写的话 DApp 默认你只支持 legacy，
  它就不会给你发 v0 交易；写错了则可能收到你解析不了的格式。
- **`accounts` 是 getter**，因为 Wallet Standard 要求它随时反映最新状态。
  连接后 `accounts` 从 `[]` 变成 `[{address, publicKey, chains, features}]`，
  DApp 监听到变化才会更新 UI。
- **feature 名字是字符串常量**，`solana:` 前缀的属于 Solana 生态约定。

### 3.4 signTransaction vs signAndSendTransaction

| | 输入 | 输出 | 谁广播 |
| --- | --- | --- | --- |
| `signTransaction` | 交易字节 | **签名后的交易字节** | DApp 自己调 `sendRawTransaction` |
| `signAndSendTransaction` | 交易字节 | **signature** | 钱包直接广播 |

`wallet-adapter` 的策略是：**优先用 `signAndSendTransaction`**（如果钱包声明支持），
因为它少一次往返，而且钱包可以自己控制 RPC 端点和重试。这就是为什么本项目里
`signAndSendTransaction` 的实现更长（要建 `Connection`、处理 `sendOptions`、
捕获 RPC 错误），而 `signTransaction` 只做签名。

**本项目踩的坑正是这里**：DApp 走 `signAndSendTransaction` 时，
wallet-adapter 传过来的是 **message-only 字节**（`transaction.serializeMessage()`
的结果），不是完整交易 —— 见第 6 节。

### 3.5 为什么字节要 base64 编码过桥

`window.postMessage` 用**结构化克隆算法**传数据。它支持 `Uint8Array`，
但**不支持**：类实例（`Keypair`、`PublicKey`）、函数、`Symbol`、某些 TypedArray
的边界情况。

Wallet Standard 规定交易以 `Uint8Array` 传递。本项目进一步转成 base64 字符串：

```js
// src/wallet.js
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;                          // ← 分块！
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
```

两个细节值得学：

1. **分块是必须的**。`String.fromCharCode(...bytes)` 把 689 个字节展开成 689 个实参
   还行，但把一笔大交易（几千字节）展开会撞上 JS 引擎的实参数量上限，直接
   `RangeError: Maximum call stack size exceeded`。按 `0x8000` 分块就安全了。
2. **入参类型要在源头校验**。DApp 传错类型（比如传了对象）时，如果闷头 base64
   编码，后台只会看到一串垃圾字节，报 `Reached end of buffer` —— 你根本不知道
   问题出在 DApp 侧。所以 `asBytes()` 会明确报出收到了什么类型。

`src/background.js` 里的 `b64()` / `bytes()` 是同一对函数的镜像，因为
`chrome.runtime.sendMessage` 也走结构化克隆，而且中间可能经过 JSON 序列化。

### 3.6 安全：谁都能给你 postMessage

页面里**任何**脚本都能执行 `window.postMessage(...)`，包括广告、被注入的恶意代码。
所以 `src/content.js` 做了两道检查：

```js
// ① 只认自己注入的那份 wallet.js
if (event.source !== window) return;
if (!msg || msg.source !== 'minimal-solana-wallet') return;

// ② action 白名单，防止有人构造 'RESET' 之类的消息
const ALLOWED_ACTIONS = new Set(['getAccount', 'signTransaction', 'signAndSendTransaction']);
if (!ALLOWED_ACTIONS.has(msg.action)) throw new Error(`Unsupported wallet action: ${msg.action}`);
```

第 ② 道尤其重要：`chrome.runtime.sendMessage({type: ...})` 的 type 和本项目的
后台动作名（`CREATE`/`RESET`/`EXPORT`）不是一套命名空间，但白名单能确保页面
永远只能触发这三个只涉及签名的动作，**不可能**通过页面消息导出私钥或重置钱包。

> 本项目**没有做** origin 白名单：任何网站都能请求签名。README 里明确写了这点。
> 生产钱包必须弹确认框显示"哪个域名要做什么"，这是防钓鱼的核心，别省。

---

## 4. 密码学：私钥怎么存在本地

### 4.1 为什么不能明文存

`chrome.storage.local` 落盘在用户目录里，**没有加密**。任何能读磁盘的程序、
以及任何拿到同一扩展 ID 的恶意扩展，都能直接读出来。所以存进去的必须是密文。

### 4.2 完整流程

```
用户输入的密码 (string)
   │  PBKDF2(password, salt, 250000 次迭代, SHA-256)
   ▼
AES-256 密钥 (CryptoKey，永不导出 extractable:false)
   │  AES-256-GCM(key, iv, 64 字节 secret key)
   ▼
密文  →  和 salt、iv 一起存进 chrome.storage.local
```

对应代码（`src/background.js`）：

```js
async function derive(password, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:250000, hash:'SHA-256' },
    base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);   // ← 两个 false = 不可导出
}

async function encrypt(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));   // 每次随机
  const iv   = crypto.getRandomValues(new Uint8Array(12));   // 每次随机
  const key  = await derive(password, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, secret));
  return { salt:b64(salt), iv:b64(iv), ciphertext:b64(ciphertext) };
}
```

每个参数的作用：

| 参数 | 值 | 为什么 |
| --- | --- | --- |
| **iterations** | 250000 | 拖慢暴力破解。攻击者每猜一次密码都要跑 25 万次 SHA-256 |
| **salt** | 16 字节随机 | 让"同一个密码"每次派生出不同密钥，彩虹表失效；必须明文存（解密要用） |
| **iv** | 12 字节随机 | GCM 的 nonce。**绝对不能重复**：同一 key 下重用 IV 会彻底泄露明文 |
| **AES-GCM** | 256 位 | 认证加密（AEAD）：既加密又防篡改 |

存进 `storage.local` 的结构（键名 `minimal_wallet_v2`）：

```json
{ "version": 1,
  "address": "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9",
  "encrypted": { "salt": "...", "iv": "...", "ciphertext": "..." } }
```

`address` 明文存是故意的 —— popup 锁着的时候也要能显示地址、查余额。

### 4.3 GCM 的副作用：密码错了会怎样

GCM 自带完整性校验（authentication tag）。密码错 → 派生出错误的密钥 →
解密时 tag 校验失败 → WebCrypto 抛一个**极其笼统**的 `OperationError`，
不带任何信息。用户看到 "OperationError" 只会一头雾水，所以 `src/background.js`
把它翻译成人话：

```js
try {
  secret = await decrypt(stored.encrypted, msg.password);
} catch {
  throw new Error('Wrong password.');     // AES-GCM 解密失败 = 密码不对（或数据被改过）
}
```

### 4.4 解锁态放哪

解密出的明文私钥放 `chrome.storage.session`（见 2.3）：浏览器一关就没了，
且默认只有扩展自己能读，比 `local` 安全一档。**永远不要**把明文私钥写进
`storage.local`。

### 4.5 已知局限（README 也写了）

- 没有自动锁定超时（解锁后一直到浏览器关闭）
- 没有交易确认 UI（签名前不给你看"要转给谁、多少钱"）
- 没有 origin 白名单
- PBKDF2 在弱密码下仍然挡不住离线爆破

这是教学项目，**别放真钱**。

---

## 5. 工程：构建与测试

### 5.1 四个入口

```js
// vite.config.js
build: { rollupOptions: {
  input: {
    popup:      'src/popup.jsx',      // → dist/assets/popup.js
    background: 'src/background.js',  // → dist/assets/background.js
    content:    'src/content.js',     // → dist/assets/content.js
    wallet:     'src/wallet.js'       // → dist/assets/wallet.js
  },
  output: {
    entryFileNames: 'assets/[name].js',        // ← 注意：没有 [hash]
    chunkFileNames: 'assets/chunk-[hash].js',
    assetFileNames: 'assets/[name][extname]'
  }
}}
```

**为什么入口文件名不能带 hash？** 因为 `manifest.json` 里的路径是写死的字符串
（`"service_worker": "assets/background.js"`）。普通网页可以靠 HTML 里的引用自动
指向带 hash 的文件，manifest 不行。所以入口固定名，公共 chunk 才带 hash。

### 5.2 public/ 目录

`public/` 下的文件被 Vite **原样拷贝**到 `dist/`，不经过打包。本项目只有两个：

```
public/manifest.json  →  dist/manifest.json
public/popup.html     →  dist/popup.html
dist/assets/*.js       ←  这些才是 vite build 的产物
```

`popup.html` 里直接写 `<script type="module" src="/assets/popup.js">`，
指向打包产物。图标也可以放 `public/`（本项目目前用的是 `wallet.js` 里内联的
data URI SVG，所以不需要图片文件）。

### 5.3 依赖里的两个"障眼法"

```jsonc
"web3": "npm:@solana/web3.js@^1.98.4",   // npm alias：本地叫 web3，实际装的是 @solana/web3.js
"devDependencies": {}                     // 没有 dev 依赖，连测试框架都不用
```

那个 alias 是为了让 `import { Connection } from 'web3'` 短一点，
但要小心：**它和以太坊的 `web3` 包完全无关**，只是重名。新手看到 `from 'web3'`
容易懵，这里说明一下。

顺带一个实用技巧：**想知道项目真正用了什么，别只看 package.json，去看 import。**
本项目源码里实际出现的第三方包只有六个：

```
@wallet-standard/core   bs58   react   react-dom/client   tweetnacl   web3
```

`package.json` 里还列了 `@solana/wallet-standard` 和 `@wallet-standard/app`，
但源码没有直接 import 它们（`@wallet-standard/core` 自己会依赖
`@wallet-standard/app` / `base` / `features` / `wallet`）。读代码时以 import 为准，
`dependencies` 里多出来的条目不影响打包产物 —— Vite 只会把被 import 到的代码打进去。

### 5.4 零依赖测试

`npm test` 实际是：

```
node scripts/test-tx.mjs && node scripts/test-keys.mjs
```

两个脚本都用 Node 内置的 `node:assert/strict`，加一个二十行的手写 runner：

```js
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}
// ... 末尾统一打印，全过则 exit 0
```

不用 jest/vitest 的理由：被测代码（`src/tx.js`、`src/keys.js`）是纯函数，
不碰 DOM 也不碰 `chrome.*`，`node` 直接就能跑。零依赖 = 装得快、不会版本冲突。

**测试可复现的关键**是固定输入：

```js
// scripts/test-tx.mjs
const BLOCKHASH = bs58.encode(new Uint8Array(32));            // 全零 blockhash，不用调 RPC
const payer     = Keypair.fromSeed(new Uint8Array(32).fill(1)); // 固定种子 → 固定密钥
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
```

> 小趣闻：全零的 32 字节 base58 编码是 32 个 `1`，而 System Program 的地址
> **也**是 32 个 `1`（它同样是全零）。所以测试里 blockhash 和程序地址看起来一样，
> 不是复制粘贴错了。

`Keypair.fromSeed(seed)` 内部是 `SHA-512(seed)` 派生 ed25519 密钥，
纯确定性运算，因此不需要真随机数，也不需要网络。

---

## 6. 案例一：Reached end of buffer unexpectedly

这是本项目最主要的 bug，也是最值得学的一个：**错误消息和真正的原因相距十万八千里**。

### 6.1 症状

在 DApp 里点 Donate → 弹窗报错：

```
Reached end of buffer unexpectedly
```

没有堆栈指向我们的代码，没有说收到的是什么，看起来像是"数据被截断了"。
第一反应往往是去怀疑网络、怀疑 DApp 少传了字节 —— 全都是错的方向。

### 6.2 根因

DApp 走 `signAndSendTransaction` 时，wallet-adapter 传过来的是
**message-only 字节**（`transaction.serializeMessage()` 的结果），
而旧代码只按"完整交易"去解析。

`VersionedTransaction.deserialize(bytes)` 的读取顺序是：

```
① 在 byte 0 读一个 compact-u16 → 当作"签名数量"
② 读 N × 64 字节 → 当作签名
③ 从当前位置开始 → 当作 message
```

喂给它一段 legacy message，会发生什么：

```
byte 0 = 1        ← 这其实是 numRequiredSignatures（需要 1 个签名者）
                     但它被当成"有 1 个签名"
①  signatureCount = 1，compact-u16 占 1 字节
②  读走 byte 1..64 当作那个"签名"
③  从 byte 65 开始当 message
```

而 byte 65 在真实布局里是**账户表中间**的某个字节：

```
byte:    0  1  2  3 | 4 ................ 35 | 36 ................. 67 | ...
真实:   header(3) 账户数 | key[0] = 付款人公钥  | key[1] = 某个公钥       |
                          ↑ 4..35              ↑ 36..67，byte 65 = key[1] 的第 29 字节
```

### 6.3 实测：错位之后到底读到什么

以下数据由脚本实跑得出（固定种子，可复现）：

| 指令数 | message 长度 | 账户数 | 错位起点 | 该处字节 | 最高位 | 落在 | 报出的错 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 150 | 3 | byte 65 | 201 `0xC9` | 1 | key[1]+29 | `Transaction message version 73 deserialization is not supported` |
| 2 | 199 | 4 | byte 65 | 201 `0xC9` | 1 | key[1]+29 | `Transaction message version 73 deserialization is not supported` |
| 3 | 248 | 5 | byte 65 | 201 `0xC9` | 1 | key[1]+29 | `Transaction message version 73 deserialization is not supported` |
| 4 | 297 | 6 | byte 65 | 80 `0x50` | 0 | key[1]+29 | `Reached end of buffer unexpectedly` |
| 12 | 689 | 14 | byte 65 | 125 `0x7D` | 0 | key[1]+29 | `Reached end of buffer unexpectedly` |

读懂这张表：

- 错位起点永远是 **byte 65** = 1（compact-u16 长度）+ 64（一个签名）。
- 那个字节是某个公钥的第 29 字节，**取值随内容变化**，所以报错也变：
  - 最高位 = 1（如 201）→ 解析器以为是 versioned message，版本号 `201 & 0x7f = 73`
    → "version 73 不支持"
  - 最高位 = 0（如 80、125）→ 解析器以为是 legacy message，于是从 byte 65 开始
    读 header、读账户数、再读 32×N 字节的账户表 → **一路读出缓冲区末尾**
    → `Reached end of buffer unexpectedly`
- 为什么 byte 65 上的公钥会随指令数变化？因为账户表的排列由 `Message.compile`
  对整笔交易的指令集合做分组重排（签名者 / 可写 / 只读）+ 去重决定，
  指令一变，排在 key[1] 上的地址就变。实测：

```
count=1   key[1] = 9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu  → 第 29 字节 = 201
count=4   key[1] = 8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe  → 第 29 字节 = 80
count=12  key[1] = 2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1  → 第 29 字节 = 125
```

**这就是为什么"同一笔操作有时报 A 有时报 B"**：错误消息取决于被误读的那个字节，
而那个字节本质上是随机的公钥内容。用错误消息去猜原因，在这种 bug 上是徒劳的。

顺便看同一份 150 字节的**正确**解析结果：

```
version           = legacy
staticAccountKeys = [ AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9,   ← 付款人
                      9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu,   ← 收款人
                      11111111111111111111111111111111 ]              ← System Program
instructions      = 1
```

数据一直是完整的，只是被用错了格式去读。

### 6.4 修复

见 1.6 引用的 `src/tx.js`。三个要点：

1. **两种形态都支持**：先按首字节最高位猜一种，失败自动试另一种。
2. **提前挡掉不可能的输入**：0 字节、超过 `PACKET_DATA_SIZE`(1232) 字节直接给清晰报错，
   不浪费时间去解析。
3. **错误消息自带证据**：两种解析都失败时，把字节摘要（长度 + 前 8 字节 hex）
   和两次的原始错误一起抛出来。下次再出问题，一眼就能看出收到的是什么。

另外 legacy message 走的是 `Transaction.populate()` + `partialSign()`，
而不是 `VersionedTransaction.sign()`，因为 `signTransaction` 需要支持多签场景下的
**部分签名**（`requireAllSignatures: false`）—— `VersionedTransaction.sign()`
要求所有签名者都签完。

### 6.5 教训

- **二进制解析的错误消息不可信**。"缓冲区读完"通常意味着"你从错误的偏移开始读"，
  而不是"数据被截断"。
- **别信第一直觉去改 DApp**。先把自己收到的原始字节 dump 出来看（第 8 节）。
- **写测试时用固定种子**。这个 bug 的报错内容依赖具体字节，如果测试用随机密钥，
  你甚至无法稳定复现同一条错误消息。

---

## 7. 案例二：账号"消失"，每次都要重新空投

### 7.1 症状

改一行代码 → `npm run build` → 重载扩展 → 打开 popup，钱包变成"还没创建"。
只好重新 Create，得到一个**新地址**，再去 devnet 空投一次。
反复调试几十次之后，一堆地址里各躺着一点测试币，谁也说不清哪个是"当前"的。

### 7.2 一个常见误解：私钥根本没丢

代码本身**一直是持久化**的：私钥加密后写在 `chrome.storage.local`，
关 popup、service worker 被回收、重新 build 都不会动它。`CREATE` 也早就有保护：

```js
// src/background.js —— 绝不静默覆盖已有 vault
if (stored) {
  throw new Error(`Wallet already exists (${stored.address}). Reset it first if you want a new account.`);
}
```

所以问题不在"没存"，而在"**存的地方换了**"。

### 7.3 根因：扩展 ID 决定 storage 命名空间

回到 2.3 那句话：`chrome.storage.local` **按扩展 ID 隔离**。
再回到 2.4：未打包扩展的 ID **默认由加载路径推导**。

于是：

```
删除后重新 Load unpacked  →  路径没变，ID 通常也不变    ✔ 数据还在
把 dist/ 复制到别的目录    →  ID 变                     ✘ 数据"消失"
manifest 没有 key + 重装   →  可能重新推导              ✘ 数据"消失"
```

数据其实还躺在旧 ID 的命名空间里，只是新的扩展实例读不到它 —— 就像一个还在的
保险箱，钥匙换了。

### 7.4 怎么自己确认

1. `chrome://extensions` 打开"开发者模式"，看扩展卡片上的 **ID**。
   重载前后各记一次，不一样就是这个问题。
2. service worker 控制台里跑：

```js
chrome.storage.local.get(null, console.log)   // {} 表示这个命名空间是空的
```

3. 想看旧命名空间里的数据，去
   `chrome://extensions` → 该扩展 → "检查视图" → DevTools → Application →
   Extension Storage。

### 7.5 修复

**① 钉死 ID**：`public/manifest.json` 加了 `key` 字段（一个 base64 公钥），
从此 ID 恒定为 `gbkhjkllidmdjheioadjnpebiohlhfoc`，`dist/` 放哪都一样。

**② 加了导入功能**：`src/keys.js` + `IMPORT` 动作，让你能用一份导出的私钥
在新命名空间里恢复同一个地址。这是"最后一道保险" —— 即使 ID 真的变了、
即使你换了浏览器，只要私钥在，地址就在。

### 7.6 一次性迁移（升级时要做的）

加 `key` 会让 ID **变一次**，所以旧 vault 这一次读不到：

1. **先别重载**，用当前版本 popup 点 `Export Secret Key`，存好那串 base58
2. `chrome://extensions` 移除旧扩展 → Load unpacked 选新的 `dist/`
3. 在新界面用 `Import Secret Key` 粘回去 → 同一个地址、同一份余额

如果之前没导出过，那笔 devnet 币就拿不回来了，只能对新地址再空投一次 ——
但从这次起地址永久固定。

### 7.7 教训

- **"数据丢了"往往不是数据的问题，是命名空间/路径/环境的问题。** 先确认"我在读哪个抽屉"。
- **任何加密钱包都必须提供导出私钥**。没有导出功能的钱包 = 一次意外就永久锁死。
- **导入时的校验要严不要宽**：宁可拒绝一个"可能能用"的输入，也不要悄悄生成一个
  不同的地址（见 1.2）。
- **危险操作要二次确认**：`RESET` 在 popup 里要点两次，第一次点击只是把按钮
  变成"确认重置"并提示先备份。

---

## 8. 怎么调试

### 8.1 三个不同的 console

这是新手最容易卡住的地方 —— 日志散在三个不同的控制台里：

| 想看谁的日志 | 去哪 |
| --- | --- |
| `background.js`（签名、RPC、导入） | `chrome://extensions` → 本扩展 → **"检查视图: service worker"** |
| `wallet.js`（MAIN world） | DApp 页面按 F12 → Console |
| `content.js`（ISOLATED world） | 同上，DApp 页面的 Console |
| `popup.jsx`（侧边栏 / 独立窗口） | 在侧边栏里右键 → **检查**；独立窗口或标签页里直接 F12 |

本项目所有后台日志都带 `[Wallet]` 前缀，方便过滤：

```
[Wallet] signAndSendTransaction: message (150B) -> legacy message
[Wallet] Transaction sent: <base58 signature>
[Wallet] Imported account: AKnL4...
[Wallet] dApp requested solana:mainnet but the wallet is set to devnet; using devnet.
```

那行 `signAndSendTransaction: message (150B)` 就是第 6 节 bug 的定位关键：
它直接告诉你**收到的字节是哪种形态、多长**。

### 8.2 看存储

service worker 控制台里：

```js
await chrome.storage.local.get(null)     // vault（密文）+ 网络选择
await chrome.storage.session.get(null)   // 解锁态（明文私钥 base64）—— 看完记得清
```

### 8.3 在 Node 里复现字节问题

这是本项目最有效的一招。流程：

1. 在 `background.js` 里把收到的字节打出来（或用现成的 `preview()`）；
2. base64 复制出来；
3. 写个小脚本还原：

```js
const raw = new Uint8Array(Buffer.from(PASTE_BASE64, 'base64'));
// 然后随便调 VersionedMessage.deserialize(raw) / VersionedTransaction.deserialize(raw)
```

好处：不用重载扩展、不用点 DApp、可以打断点、可以反复试。
`scripts/test-tx.mjs` 里的用例就是这么固化下来的 —— **调试脚本用完就该变成回归测试**。

### 8.4 常见 RPC / 签名报错对照

| 报错 | 真正的原因 |
| --- | --- |
| `Reached end of buffer unexpectedly` | 用错了格式解析字节（见第 6 节），不是数据截断 |
| `Transaction message version N deserialization is not supported` | 同上，N 是被误读的一个随机字节 |
| `Blockhash not found` | 交易过期了（>60~90 秒），重新取 blockhash 再签 |
| `signature verification failed` | 签名和 message 不匹配，或签名者不在账户表里 |
| `Insufficient funds for ... rent-exempt minimum` | 余额不够付手续费或 rent 豁免 |
| `Transaction too large` | 超过 1232 字节 |
| `Account in use` | 同一账户的交易并发冲突，重试即可 |
| `429` / `Too Many Requests` | 公共 RPC 限流，换端点或等待；空投被限流用 faucet.solana.com |

### 8.5 改完代码怎么让它生效

```
npm run build
   ↓
chrome://extensions → 本扩展 → 点「重新加载」(⟳)
   ↓
DApp 页面按 Ctrl+R 刷新        ← 别忘！content script 和 wallet.js 只在页面加载时注入
```

只重载扩展不刷新页面，页面里跑的还是**旧的** wallet.js，会出现"我明明改了却没效果"
的假象。反过来，只刷新页面不重载扩展，后台还是旧代码。两边都要做。

---

## 9. 术语速查表

| 英文 | 中文/含义 | 在本项目哪里出现 |
| --- | --- | --- |
| account | 账户，链上的基本单位（地址+余额+数据） | 到处都是 |
| lamport | 1 SOL 的 10⁻⁹ | `LAMPORTS_PER_SOL` |
| program | 合约，`executable` 的账户 | System Program |
| keypair | 密钥对 | `Keypair.fromSecretKey()` |
| seed | 32 字节种子，派生出密钥对 | `Keypair.fromSeed()`（测试用） |
| secret key | 64 字节私钥 = seed ‖ pubkey | `src/keys.js` |
| public key / address | 32 字节公钥，base58 后即地址 | `kp.publicKey.toBase58()` |
| base58 | 去掉 `0OIl` 的编码 | `bs58` |
| instruction (ix) | 指令，交易里最小的执行单元 | `SystemProgram.transfer()` |
| message | 交易的"待签名内容" | `src/tx.js` |
| compact-u16 | 变长整数编码 | 第 6 节 bug 的根源 |
| recentBlockhash | 32 字节近期区块哈希，决定交易有效期 | 由 DApp 提供 |
| signature | 64 字节 ed25519 签名 | `tx.sign([keypair])` |
| legacy / v0 | 两种交易版本 | `supportedTransactionVersions` |
| ALT | Address Lookup Table，v0 用来压缩账户表 | 未使用（但支持解析） |
| commitment | 确认级别 processed/confirmed/finalized | `new Connection(url,'confirmed')` |
| preflight | 广播前的本地模拟 | `sendOptions()` |
| RPC / endpoint | JSON-RPC 接口 / 服务地址 | `endpoints` |
| devnet / mainnet | 测试网 / 主网 | 侧边栏的网络下拉框 |
| faucet / airdrop | 测试币水龙头 / 空投 | `AIRDROP` 动作 |
| MV3 | Manifest V3，当前扩展规范版本 | `manifest.json` |
| service worker | MV3 的后台脚本，会被回收 | `src/background.js` |
| MAIN / ISOLATED world | 页面 JS 世界 / 内容脚本世界 | `src/wallet.js` / `src/content.js` |
| content script | 注入到页面的扩展脚本 | `src/content.js` |
| popup | 点扩展图标弹出的页面，失焦即销毁 | 本项目已弃用（见 2.7） |
| Side Panel | 浏览器侧边的常驻面板，失焦不关 | manifest 的 `side_panel` |
| `chrome.storage.local` | 扩展专属持久存储，按 ID 隔离 | vault |
| `chrome.storage.session` | 浏览器关闭即清的存储 | 解锁态 |
| extension ID | 扩展唯一标识，决定 storage 命名空间 | manifest 的 `key` |
| Wallet Standard | DApp 与钱包的互操作标准 | `src/wallet.js` |
| wallet-adapter | DApp 侧的钱包适配库（Solana 生态） | 不在此仓库，是对端 |
| feature | Wallet Standard 里的能力单元 | `features` 对象 |
| PBKDF2 | 密码派生函数（多次迭代抗爆破） | `derive()` |
| AES-256-GCM | 认证加密算法 | `encrypt()` / `decrypt()` |
| salt / IV | 派生盐 / 加密初始向量，都需随机且不重复 | `encrypt()` |
| structured clone | `postMessage` 的数据克隆算法 | 为什么要 base64 |
| vault | 本项目对"加密后的私钥记录"的称呼 | `saveVault()` |

---

## 10. 建议的阅读顺序与动手练习

### 10.1 读代码的顺序

1. `public/manifest.json` —— 先搞清楚有哪几个部件、各自跑在哪
2. `src/content.js`（43 行）—— 最短，看懂桥接和消息格式
3. `src/wallet.js` —— 看 Wallet Standard 的钱包对象长什么样
4. `src/tx.js` —— 纯函数，配合第 6 节读
5. `src/keys.js` —— 纯函数，看输入校验怎么写
6. `src/background.js` —— 最后读，它是所有东西的汇聚点
7. `src/popup.jsx` —— UI，看懂 `run()` 这个统一包装就够了
8. `scripts/test-tx.mjs`、`scripts/test-keys.mjs` —— 反过来验证你的理解

### 10.2 练习（由易到难）

- 把余额显示从 lamports 改成 SOL，保留 4 位小数
- 给 popup 加一个"复制地址"按钮
- 加自动锁定：`chrome.alarms` 每 10 分钟检查一次，超时调 `LOCK`
- 加签名确认 UI：签名前解析 message，把"转给谁、多少 SOL、手续费"显示出来，
  用户点确认再签（**这是本项目最缺的安全特性**）
- 加 origin 白名单：在 `background.js` 里用 `sender.tab?.url` 判断来源域名，
  第一次访问时弹窗询问是否信任
- 支持 `storage.sync`：把网络选择同步到其它设备（**只同步偏好，绝不同步私钥**）

### 10.3 延伸阅读

- Solana 交易结构：<https://solana.com/docs/core/transactions>
- Versioned transactions：<https://solana.com/docs/advanced/versions>
- @solana/web3.js API：<https://solana-labs.github.io/solana-web3.js/>
- Wallet Standard 规范：<https://github.com/wallet-standard/wallet-standard>
- Chrome MV3 service worker：<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers>
- chrome.storage：<https://developer.chrome.com/docs/extensions/reference/api/storage>
- WebCrypto（PBKDF2 / AES-GCM）：MDN `SubtleCrypto`
- Devnet 水龙头：<https://faucet.solana.com>
- 区块浏览器（右上角记得切到 Devnet 集群）：<https://explorer.solana.com/?cluster=devnet>

### 10.4 安全提醒

这是一个**教学项目**，README 里列的局限都是真实的：没有交易确认 UI、
没有 origin 白名单、没有自动锁定。任何网站都能请求它签名。

- 只用 devnet，或用一个专门的一次性地址
- 不要导入任何存有真实资产的私钥
- 导出的私钥不要存进云盘、聊天工具、代码仓库
- 想上生产，先把 10.2 里的"签名确认 UI"和"origin 白名单"做完


