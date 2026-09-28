# Solana 入门：用 Rust 测试 Anchor 程序

这份文档解释当前项目如何测试 `initialize` 指令，适合刚接触 Solana、Anchor 和 Rust 的开发者。

测试文件：

- `programs/my-project/tests/test_initialize.rs`
- 程序入口：`programs/my-project/src/lib.rs`
- 初始化账户约束：`programs/my-project/src/instructions/initialize.rs`
- 账户状态：`programs/my-project/src/state.rs`

## 1. 先建立整体概念

一次 Solana 程序调用，大致经过下面的流程：

```text
客户端代码
  |
  | 构造 Instruction（要调用哪个程序、带哪些账户、传什么数据）
  v
Transaction（把一条或多条 Instruction 放在一起）
  |
  | payer 签名并支付手续费
  v
RPC Client -> Solana Validator
  |
  v
链上程序执行，读写账户
```

几个重要名词：

| 名词 | 含义 |
| --- | --- |
| Program | 链上运行的程序，类似智能合约；本项目的 ID 是 `8ikay7TRNuyuyL38GnNfTQmcj2uuxnUDvaBWcUbgw4XS` |
| Account | Solana 上保存数据或余额的账户；程序本身也占用一个账户地址 |
| Instruction | 对程序的一次调用，包含程序 ID、账户列表和序列化后的参数 |
| Transaction | 提交给 validator 执行的交易，可以包含多条 instruction |
| Signer | 对交易签名的账户；本测试中是 payer |
| RPC Client | 客户端和 validator 通信的接口 |
| Validator | Solana 节点；本地开发时由 `solana-test-validator` 提供 |
| Lamport | Solana 的最小货币单位，`1 SOL = 1_000_000_000 lamports` |

## 2. 本项目的 initialize 做什么

`initialize` 在 `programs/my-project/src/instructions/initialize.rs` 中定义了三个账户：

```rust
pub struct Initialize<'info> {
    pub payer: Signer<'info>,
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}
```

含义如下：

- `payer` 必须签名，并支付创建 `counter` 账户的费用。
- `counter` 是要创建的业务账户。
- `system_program` 是 Solana 内置系统程序，负责创建账户和转账。

执行成功后，程序写入：

```rust
counter.count = 0;
counter.authority = payer.key();
```

`Counter` 的链上数据结构位于 `programs/my-project/src/state.rs`：

```rust
pub struct Counter {
    pub count: u64,
    pub authority: Pubkey,
}
```

## 3. PDA 是什么

本项目的 `counter` 不是随机生成的普通账户，而是 PDA（Program Derived Address）：

```rust
seeds = [COUNTER_SEED],
bump
```

其中 `COUNTER_SEED` 是：

```rust
pub const COUNTER_SEED: &[u8] = b"counter";
```

测试中使用完全相同的 seed 计算地址：

```rust
let counter_pubkey = Pubkey::find_program_address(
    &[my_project::constants::COUNTER_SEED],
    &my_project::id(),
)
.0;
```

PDA 的特点：

1. 地址由 `seed + program_id` 确定。
2. 不需要保存一个随机 keypair。
3. 程序可以根据相同 seed 再次推导出同一个地址。
4. Anchor 的 `init` 会在该地址创建账户。

因此，本项目只有一个固定的 Counter PDA。第一次初始化会创建它，第二次初始化会失败，因为账户已经存在。

## 4. 测试代码逐步解释

### 4.1 创建 RPC 客户端

```rust
let client = RpcClient::new("http://127.0.0.1:8899".to_string());
```

这表示测试连接本地 validator。运行测试前，需要另开终端启动：

```bash
solana-test-validator
```

测试不会自己启动 validator，也不会自己部署程序。程序需要先完成：

```bash
anchor build
anchor deploy
```

### 4.2 读取 payer 钱包

```rust
let payer_path = std::env::var("ANCHOR_WALLET")
    .unwrap_or_else(|_| format!("{}/.config/solana/id.json", std::env::var("HOME").unwrap()));
let payer = read_keypair_file(payer_path).expect("Failed to read provider wallet");
```

`payer` 是：

- 交易手续费支付者；
- `counter` 账户的创建费用支付者；
- `authority` 字段的写入对象；
- 本交易的签名者。

优先读取 `ANCHOR_WALLET`，因为 Anchor 会通过这个环境变量指定钱包。没有该变量时，使用默认钱包：

```text
~/.config/solana/id.json
```

可以检查钱包余额：

```bash
solana balance --url http://127.0.0.1:8899
```

### 4.3 构造 Anchor instruction

```rust
let anchor_instruction =
    anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        my_project::id(),
        &my_project::instruction::Initialize {}.data(),
        my_project::accounts::Initialize {
            payer: payer_pubkey,
            counter: counter_pubkey,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
```

这里有三部分：

1. `my_project::id()`：指定要调用哪个链上程序。
2. `Initialize {}.data()`：生成 Anchor 的 instruction discriminator 和参数数据。
3. `Initialize { ... }.to_account_metas(None)`：按照 Anchor 的账户约束生成账户列表。

`Initialize {}` 没有业务参数，所以只需要生成空的指令参数结构；Anchor 会自动为它编码 instruction discriminator。

### 4.4 为什么做类型转换

Anchor 1.2 使用的 Solana 类型和 RPC 客户端依赖的 Solana 类型来自不同 crate：

- Anchor 侧使用 `anchor_lang::prelude::Pubkey`；
- 新版交易/RPC 侧使用 `solana_address::Address`；
- Anchor 侧的 instruction 使用 Anchor 兼容的 `Instruction`；
- RPC 交易使用 `solana_instruction::Instruction`。

所以测试把账户地址逐个转换：

```rust
Address::from(meta.pubkey.to_bytes())
```

这不是地址变化，而是把同样的 32 字节公钥转换成另一个 crate 的类型。

### 4.5 生成 transaction 并签名

```rust
let transaction = Transaction::new(
    &[&payer],
    Message::new(&[instruction], Some(&payer.pubkey())),
    client.get_latest_blockhash()?,
);
```

交易需要：

- instruction；
- fee payer；
- 最近的 blockhash，防止交易过期；
- payer 的签名。

然后提交：

```rust
client.send_and_confirm_transaction(&transaction)?;
```

这个调用会通过 RPC 将交易发送给 validator，并等待确认。只有交易执行成功，后面的账户读取才会看到新状态。

### 4.6 读取并反序列化账户

```rust
let account = client
    .get_account(&counter)
    .expect("Failed to fetch Counter account");
let mut account_data = account.data.as_slice();
let counter_account = my_project::state::Counter::try_deserialize(&mut account_data)
    .expect("Failed to deserialize Counter account");
```

Solana 账户中的 `data` 只是字节数组。Anchor 账户通常包含：

```text
8 字节账户 discriminator + 账户字段序列化数据
```

`try_deserialize` 会检查 discriminator，并将字节还原成 Rust 的 `Counter` 结构。

最后断言：

```rust
assert_eq!(counter_account.count, 0);
assert_eq!(counter_account.authority, payer_pubkey);
```

这比只检查交易返回成功更可靠，因为它验证了程序确实写入了预期状态。

## 5. 为什么测试支持重复运行

Counter 使用固定 PDA。第一次运行会创建账户；第二次运行再次调用 `init` 时，System Program 会报账户已经存在。

因此测试先检查账户是否存在：

```rust
if let Ok(account) = client.get_account(&counter) {
    // 读取并验证已有账户，然后结束测试
    return;
}
```

这让测试可以在复用旧 ledger 的 validator 上重复执行。

如果想测试“第一次初始化”的完整行为，可以停止 validator 并清除旧 ledger，然后重新启动：

```bash
pkill solana-test-validator
rm -rf test-ledger
solana-test-validator --ledger test-ledger
```

清除 ledger 会删除本地链上的所有测试账户，请不要对真实网络执行类似操作。

## 6. 推荐的完整操作顺序

终端一：

```bash
cd /home/quant/work/solana/my-project
solana-test-validator --ledger test-ledger
```

终端二：

```bash
cd /home/quant/work/solana/my-project
solana config set --url http://127.0.0.1:8899
solana balance
anchor build
anchor deploy
cargo test -p my-project --test test_initialize test_initialize -- --nocapture
```

也可以先单独确认程序：

```bash
solana program show 8ikay7TRNuyuyL38GnNfTQmcj2uuxnUDvaBWcUbgw4XS
```

## 7. 常见错误

### `Connection refused`

validator 没有运行，或者测试连接的端口不是 `8899`。

```bash
solana-test-validator
```

### `Failed to read provider wallet`

钱包文件不存在，或 `ANCHOR_WALLET` 指向了错误路径。

```bash
ls ~/.config/solana/id.json
solana address
```

### `insufficient funds`

payer 没有足够 SOL 支付交易费用和账户创建费用。确认 CLI 连接的是本地 validator：

```bash
solana config set --url http://127.0.0.1:8899
solana balance
solana airdrop 10
```

### `account already in use`

Counter PDA 已经初始化。可以：

- 直接再次运行当前测试，测试会读取并验证已有状态；或
- 清理本地 ledger 后重新部署和测试。

### `custom program error`

优先查看测试输出中的 program logs。常见原因包括：

- 测试使用了错误的 program ID；
- PDA seed 不一致；
- 账户列表顺序或 signer/writable 标记错误；
- 程序没有重新构建或部署；
- Anchor 账户约束不满足。

## 8. 如何测试 increment

`increment` 的账户约束比 `initialize` 简单：

```rust
pub struct Increment<'info> {
        pub counter: Account<'info, Counter>,
        pub authority: Signer<'info>,
}
```

调用时必须提供：

- `counter`：前面已经初始化的 Counter PDA，并且可写；
- `authority`：Counter 中保存的 authority，同时必须对交易签名。

程序内部会检查两件事：

1. `counter.authority == authority.key()`，否则返回 `Unauthorized`；
2. `counter.count < MAX_COUNT`，否则返回 `CounterOverflow`。

测试的核心结构是：

```text
读取 increment 前的 Counter
    |
    +-- 发送 Increment instruction
    |
读取 increment 后的 Counter
    |
断言 after.count == before.count + 1
```

测试文件中的 `send_instruction` 将 Anchor 生成的 instruction 转换成交易客户端使用的类型，然后签名并发送：

```rust
send_instruction(
        &client,
        &payer,
        Instruction::new_with_bytes(
                my_project::id(),
                &my_project::instruction::Increment {}.data(),
                my_project::accounts::Increment {
                        counter: counter_pubkey,
                        authority: payer_pubkey,
                }
                .to_account_metas(None),
        ),
);
```

这里 `Increment {}` 没有业务参数，但 `.data()` 仍然会生成 Anchor 用来识别指令的 discriminator。账户列表由 `to_account_metas(None)` 根据 `Accounts` 结构生成。

运行 increment 测试：

```bash
cargo test -p my-project --test test_increment test_increment -- --nocapture
```

每次成功运行，Counter 的 `count` 会增加 1，直到达到 `MAX_COUNT`（当前是 10）。所以这个测试不是完全无副作用的：重复运行会改变本地链状态。达到 10 后，程序会返回 `CounterOverflow`。

如果想重新从 0 学习完整流程，停止 validator、删除本地 ledger、重新启动并部署：

```bash
pkill solana-test-validator
rm -rf test-ledger
solana-test-validator --ledger test-ledger
anchor build
anchor deploy
```

> 注意：文档中的旧章节编号保留原样，方便对照之前的学习记录。

## 9. 本次改动总结

旧测试的问题是：

- 自己启动第二个 validator，容易与手动启动的 validator 冲突；
- 用错误的方式调用 `solana program run`；
- 虽然构造了 instruction，但没有把它放进 transaction 并发送；
- airdrop 使用和等待方式不可靠；
- 没有反序列化账户并验证业务状态。

现在的测试：

1. 连接已经运行的本地 validator；
2. 使用 Anchor provider 钱包；
3. 计算正确的 Counter PDA；
4. 使用 Anchor 生成 instruction 数据和账户列表；
5. 创建并签名 transaction；
6. 通过 RPC 发送并确认；
7. 读取账户并反序列化；
8. 验证 `count` 和 `authority`。

运行验证命令：

```bash
cargo test -p my-project --test test_initialize test_initialize -- --nocapture
```
