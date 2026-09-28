# Minimal Solana Browser Wallet 0.4.0

这是一个**本地开发/测试钱包**，目标是：

- 不注册用户
- 不连接钱包厂商后台
- 浏览器扩展 MV3
- 本地生成 Solana Keypair
- PBKDF2 + AES-256-GCM 加密保存 secret key
- Devnet / Mainnet
- Wallet Standard 注册
- `solana:signTransaction`
- `solana:signAndSendTransaction`
- legacy / v0 transaction
- 私钥只在 extension service worker 中解锁和签名
- 导出 / 导入私钥：账号可以在重装扩展后原样找回
- 固定扩展 ID：换目录加载 dist、删除重装都不会丢 `chrome.storage.local` 里的 vault
- 界面挂在 **Chrome 侧边栏（Side Panel）**，失去焦点不会关闭；也可以弹成独立窗口 / 新标签页
- 界面内显示余额 + 一键 Devnet 空投

Wallet Standard 的官方参考实现同样使用 `registerWallet()`；Solana 的 Wallet Standard 接口以 Uint8Array 形式传递交易/签名数据。参见：
https://github.com/wallet-standard/wallet-standard
https://github.com/wallet-standard/wallet-standard/blob/master/packages/example/wallets/src/solanaWallet.ts

## 新手扫盲文档

第一次接触「浏览器扩展 + Solana 钱包」的话，先读 **[docs/CONCEPTS.md](docs/CONCEPTS.md)**。
它把本项目涉及的概念逐条讲清楚，每节都对应到具体文件：

- Solana：账户模型、密钥（seed / 64 字节 secret key / 地址）、base58、
  交易与 message 的字节布局、compact-u16、签名签的是 message、legacy vs v0、
  recentBlockhash 与交易过期、1232 字节上限、RPC / commitment / preflight、devnet 空投
- 扩展 MV3：MAIN / ISOLATED / service worker 三个世界、service worker 会被回收、
  `storage.local` vs `session`、扩展 ID 从哪来、`web_accessible_resources`、
  `sendResponse` 为什么必须 `return true`、popup 为什么失焦就关而 Side Panel 不会
- Wallet Standard：`registerWallet`、features 能力协商、
  `signTransaction` vs `signAndSendTransaction`、为什么字节要 base64 过桥、
  postMessage 的白名单校验
- 密码学：PBKDF2(250k) + AES-256-GCM 每个参数的作用、为什么密码错只能报 `OperationError`
- 工程：Vite 四入口与"文件名不能带 hash"、零依赖测试、固定种子保证可复现

并用实测字节数据复盘了本项目踩过的两个坑：

- 第 6 节：Donate 报 `Reached end of buffer unexpectedly` 的逐字节原因
- 第 7 节：账号"消失"、每次都要重新空投的真正原因

文档最后附术语中英对照表、建议的代码阅读顺序和六道练手题。


## 构建

需要 Node.js 20+：

```bash
npm install
npm run build
```

构建后：

```text
dist/
  popup.html
  assets/
    popup.js
    popup.css
    background.js
    content.js
    wallet.js
    ...
  manifest.json
```

> ⚠️ `popup.html` 是从 `public/` **原样复制**过去的，vite 不会替它注入资源引用。
> `popup.jsx` 里 `import './popup.css'` 打包出来的 `assets/popup.css`，必须在
> `public/popup.html` 里手写一行 `<link rel="stylesheet" href="/assets/popup.css">`
> 才会被加载。漏掉这行的话界面照样能渲染出来，但**一点样式都没有**，而且
> `npm run dev` 完全看不出来 —— dev server 是通过 JS 把样式注入的。
> `npm test` 里的 `scripts/test-build.mjs` 会盯着这一行。

Chrome / Edge（需要 **Chrome 114+**，因为界面用的是 Side Panel API）：

```text
chrome://extensions
Developer mode
Load unpacked
选择 dist/
```

## 使用

1. 点浏览器工具栏上的扩展图标 —— 钱包会在**右侧侧边栏**打开，不会失焦就消失
2. Create Wallet（或用 Import Secret Key 找回原来的账号）
3. 设置本地密码
4. 选择 Devnet
5. 在「Devnet 测试币」卡片里点 `Airdrop 1 SOL` 给地址充值
6. 点 `Export Secret Key` 备份私钥 —— 重装扩展后靠它找回同一个地址
7. 打开你的 React DApp
8. DApp 通过 Wallet Standard 发现 `Minimal Solana Wallet`
9. Connect
10. Donate
11. 扩展 service worker 签名并发送

## 界面常驻：为什么以前一点别处就消失

0.3.0 及以前，manifest 里写的是 `action.default_popup`，得到的是 Chrome 的
**工具栏弹窗（browser action popup）**。它由浏览器托管，规则是硬性的：
**失去焦点的那一刻整个文档就被销毁** —— 点页面、切标签页、开 DevTools、切到别的
应用，都会让它消失，而且 `blur` 事件里 `preventDefault()` 也拦不住，没有任何 API
能让它保持打开。再点开时是一个全新页面，填了一半的表单和滚动位置全部归零。

Phantom / Solflare 那种"常驻在浏览器边上"的效果用的是 **Side Panel API**
（`chrome.sidePanel`，Chrome 114+）：那是浏览器窗口里一块真正的、宽度可拖的区域，
失焦不关、切标签页不关、跳页面也不关。本项目现在改成了这种形态：

```json
"action":      { "default_title": "Minimal Solana Wallet" },   // 没有 default_popup
"side_panel":  { "default_path": "popup.html" },
"permissions": ["sidePanel", "storage"]
```

```js
// src/background.js：点工具栏图标 → 打开侧边栏，而不是弹窗
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

> `default_popup` 必须删掉：只要它还在，点图标就永远是弹窗，`openPanelOnActionClick`
> 不会生效。另外 manifest 里的 `minimum_chrome_version: "114"` 也是必需的 ——
> 更老的 Chrome 不认识 `sidePanel` 这个权限名，会直接拒绝加载扩展。

除了侧边栏，界面右上角还有两个按钮：

| 按钮 | 做什么 | 什么时候用 |
| --- | --- | --- |
| `⧉ 窗口` | `chrome.windows.create({ type:'popup' })` 开一个独立小窗 | 想拖到第二块屏幕；这个窗口**失焦也不会关** |
| `↗ 标签页` | 在新标签页里打开同一份界面 | 要粘很长的私钥、想看清整个地址 |

三种形态共用一个 service worker 和一份 `chrome.storage`，所以余额、解锁态、网络
选择都是同一份数据。界面里挂了 `chrome.storage.onChanged` → `refresh()`，
在独立窗口里解锁，侧边栏会立刻跟着变，不会出现"一边 Locked、一边 Unlocked"。

独立窗口的 id 存在 `chrome.storage.session` 而不是内存变量里（service worker 会被
回收，见 [docs/CONCEPTS.md](docs/CONCEPTS.md) 第 2.2 节），并且已经开着时只会把它
拉到前面，不会点一次多开一个。

> 详细说明见 [docs/CONCEPTS.md](docs/CONCEPTS.md) 第 2.7 节。
> 这次改动没有动 manifest 的 `key`，扩展 ID 仍是 `gbkhjkllidmdjheioadjnpebiohlhfoc`，
> **升级不会丢 vault**，不需要重新导入私钥或重新空投。

### 界面样式

淡紫底 + 白色卡片的布局：`main` 用 `display:grid; gap:12px` 把功能切成几张卡片
（账户 / Devnet 测试币 / 解锁 / 私钥 / 危险操作），卡片内部再用 `gap:10px`；
一排按钮交给 `.actions`（`flex` + `gap:8px`，面板拖窄时自动换行，间隔不会被压掉）。

配色全部集中在 `src/popup.css` 顶部的 `:root` 变量里，换主题只动这几行：

```css
:root {
  --bg: #f4f1fe;           /* 内容区淡紫背景 */
  --card: #ffffff;         /* 卡片 */
  --line: #e7e0fa;         /* 描边 */
  --ink: #2c1a5e;          /* 主文字（深紫，比纯黑柔和） */
  --violet: #7c3aed;       /* 主色 */
  --violet-tint: #f3eeff;  /* 浅紫填充 */
  --danger: #be123c;       /* 危险操作 */
}
```

按钮分三个层级：`.btn.primary`（紫底白字，一张卡片里最多一个主操作）、
`.btn`（浅紫次要）、`.btn.danger`（红色，只给 Reset）；`.btn.mini` 是小号，
`.btn.block` 撑满一行。状态用 `.pill.on` / `.pill.off`（已解锁 / 已锁定），
提示文案统一走 `.hint`，操作结果走 `.msg`。

想边看边调：`npm run dev` 起一个普通网页版的界面（<http://127.0.0.1:5173>），
没有 `chrome.*` 所以会停在「新建钱包」那一屏，改 CSS 立刻热更新，
不用反复重载扩展。

## 账号持久化（为什么以前每次都要重新空投）

私钥用 PBKDF2(250k) + AES-256-GCM 加密后存在 `chrome.storage.local`。
关闭侧边栏、service worker 被回收、重新 `npm run build`，地址都不会变。

真正会让账号"消失"的是**扩展 ID**：`chrome.storage.local` 是按扩展 ID 隔离的，
而未打包扩展的 ID 默认由**加载路径**推导，于是：

- 删除扩展再 Load unpacked → ID 可能变 → 读不到旧 vault → 只能重新创建地址
- 从另一个目录加载 `dist/`（比如复制了一份）→ 同上

现在 manifest 里固定了 `key`，扩展 ID 恒定为：

```text
gbkhjkllidmdjheioadjnpebiohlhfoc
```

不管 dist 放在哪、重装多少次，都是同一个 storage 命名空间，账号不会丢。

> ⚠️ 加 `key` 会让扩展 ID **变一次**，所以升级到 0.3.0 时旧 vault 会读不到。
> 升级前先在旧版本里点 `Export Secret Key` 存好私钥，升级后用 `Import Secret Key` 粘回去，
> 地址和余额原样回来。之后就不会再发生了。

### 找回 / 迁移账号

1. 界面里点 `Export Secret Key`，保存那串 base58 私钥
2. 重新加载扩展
3. 在没有钱包的界面用 `Import Secret Key` 粘贴私钥 + 设一个新密码
4. 地址不变，余额还在，不需要重新空投

导入只接受 **64 字节**私钥（base58 字符串，或 `[1,2,3,…]` 形式的 JSON 数组）。
粘 32 字节（公钥或裸 seed）会直接报错，而不是悄悄当成 seed 生成另一个地址 ——
那会让你以为找回了旧账号，实际把币打进了新地址。

`Reset wallet` 需要点两次确认，并且会提示先备份私钥；`CREATE` / `IMPORT` 都不会静默覆盖已有 vault。

### Devnet 空投

界面里直接有余额显示和 `Airdrop 1 SOL` 按钮，不用再敲 `solana airdrop`。
空投失败会把 RPC 原因带出来（通常是频率/额度限制），也可以去 https://faucet.solana.com 手动领。
该按钮只在网络选择为 Devnet 时出现，主网不会误触。

## 交易解析（Donate 报 `Reached end of buffer unexpectedly` 的原因）

DApp 通过 Wallet Standard 传过来的 `transaction` 字节有两种常见形态：

1. 完整序列化交易：`signatureCount + signatures + message`
2. 只序列化了 message：`tx.serializeMessage()` / `message.serialize()`
   （wallet-adapter 的 legacy 分支，以及很多手写 Wallet Standard 代码都是这种）

旧实现只按形态 1 解析，遇到形态 2 时会把 message 的第一个字节（`numRequiredSignatures`）
当成签名数量，跳过 64 字节后所有读取整体错位，于是按消息长度不同报出：

- `Reached end of buffer unexpectedly`（消息较长，读到缓冲区末尾）
- `Expected signatures length to be equal to the number of required signatures`
- `Transaction message version N deserialization is not supported`（错位字节最高位被置位）

现在 `src/tx.js` 会根据首字节前缀判断形态，两种都支持，并覆盖 legacy / v0：

- legacy message → `Transaction.populate()` + `partialSign()`
- v0/v1 message → `new VersionedTransaction(message)` + `sign()`
- 完整交易 → `VersionedTransaction.deserialize()` + `sign()`

`signTransaction` 允许部分签名（`requireAllSignatures: false`，多签场景保留空签名槽），
`signAndSendTransaction` 要求签名齐全，缺签名时直接报错，而不是广播一笔必然失败的交易。
另外 `sendRawTransaction` 的失败原因（含 simulate 日志）现在会原样带回页面。

## 测试

`src/tx.js` 和 `src/keys.js` 都不依赖 `chrome.*`，可以直接在 Node 里跑：

```bash
npm run build   # test-build.mjs 对账的是构建产物；dist/ 不存在时它会跳过而不是失败
npm test
```

- `scripts/test-tx.mjs`：四种输入形态、部分签名、非签名者密钥、垃圾字节 / 空载荷 / 超长载荷 / 非字节类型，并带有对旧解析器报错（`Reached end of buffer`）的复现断言。
- `scripts/test-keys.mjs`：私钥导入的各种格式（base58 / JSON 数组 / Uint8Array / number[] / 带 byteOffset 的视图），以及 32 字节输入被拒绝而不是被当成 seed。
- `scripts/test-build.mjs`：构建产物对账 —— CSS 确实打包出来了、`dist/popup.html` 真的用 `<link>` 加载了它、HTML 里引用的资源都存在于 `dist/`、manifest 走的是 `side_panel` 而不是失焦即销毁的 `action.default_popup`。

## 安全说明

这是开发版，不是审计过的生产钱包。

当前 MVP 没有：

- 助记词/BIP39
- origin permission UI
- 交易确认 UI
- phishing protection
- 多账户
- hardware wallet
- secure enclave
- 自动锁定
- 交易模拟/人类可读交易预览

因此不要放真实主网资产。

## 下一步

真正改善用户体验时，最重要的是增加：

1. Connect approval 弹窗
2. Transaction approval 弹窗
3. 显示 `From / To / SOL amount / fee`
4. `simulateTransaction()` 后再允许签名
5. origin 白名单
6. 自动锁定
7. BIP39
8. address book
9. transaction history
