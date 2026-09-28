# `anchor test` 执行流程代码分析

## 1. 分析范围与结论

本文分析当前工程执行 `anchor test` 时的完整路径，包含：

- Anchor CLI 如何读取 `Anchor.toml`、构建程序和生成 IDL；
- CLI 为什么没有自动启动 validator；
- `[scripts].test = "cargo test"` 如何进入 Rust 集成测试；
- `programs/my-project/tests/test_initialize.rs` 自己启动 validator、部署程序并构造 instruction 的过程；
- Anchor 宏生成的链上入口、instruction dispatch 和账户约束；
- 当前测试为什么失败，以及哪些代码会让测试即使越过当前错误仍然得不到有效结果。

当前环境版本：

- Anchor CLI：`1.2.0`
- Solana CLI / Validator：`4.1.2`
- Cargo / Rust toolchain：`1.89.0`

核心结论：

1. `Anchor.toml` 中的 `skip_local_validator = true` 使 Anchor CLI 不启动自己的 validator，也不在测试前自动部署程序。validator 和部署完全由 Rust 测试自己负责。
2. `anchor test` 先执行 SBF 构建和 IDL 生成，然后通过 `bash -c "cargo test"` 执行测试脚本；测试脚本的退出码会传回 Anchor CLI。
3. 当前测试在 airdrop 阶段失败。`solana airdrop` 的金额单位是 SOL，代码传入的 `1000000000` 是 10 亿 SOL，不是 10 亿 lamports。
4. 即使修正 airdrop，测试仍然没有真正发送构造出的 Anchor instruction：当前 Solana CLI 没有 `solana program run` 子命令，而且构造出的 `Instruction` 没有被用于交易。
5. 当前程序 ID 配置不一致：源码 `declare_id!` 和 `Anchor.toml` 使用 `7zTre...`，但 `target/deploy/my_project-keypair.json` 对应 `8ikay...`。测试部署命令没有显式指定 program keypair/ID，也没有检查实际部署地址，因此部署目标、instruction 目标和链上入口的 `ID` 可能完全不同。

## 2. 配置与 Anchor CLI 调度

### 2.1 项目配置

`Anchor.toml` 的关键配置如下：

| 配置 | 代码位置 | 作用 |
| --- | --- | --- |
| `skip_local_validator = true` | `Anchor.toml:1` | 告诉 Anchor CLI 不要为这个 workspace 自动启动本地 validator |
| `[programs.localnet]` | `Anchor.toml:9-10` | 声明 `my_project` 的本地网程序地址为 `7zTre...` |
| `[provider]` | `Anchor.toml:12-14` | 使用 localnet 和 `~/.config/solana/id.json` 作为 Anchor provider wallet |
| `[scripts].test` | `Anchor.toml:16-17` | 测试套件实际执行 `cargo test` |

根目录 `Cargo.toml:1-5` 将 `programs/*` 纳入 Rust workspace。程序 crate 的 `Cargo.toml:8-24` 设置了：

- crate 名称为 `my_project`，库类型为 `cdylib` 和 `lib`；
- `idl-build = ["anchor-lang/idl-build"]`，供 Anchor 生成 IDL；
- `anchor-lang = "1.2.0"`。

### 2.2 CLI 的 `test` 入口

Anchor CLI 的 `test` 命令定义在 Anchor CLI 源码的 `cli/src/lib.rs:367-415`。实际处理逻辑在 `cli/src/lib.rs:4251-4443`，可以概括为：

```text
anchor test
  |
  +-- 读取 Anchor.toml
  +-- 如果未指定 --skip-build，调用 build
  +-- 计算 validator/deploy plan
  +-- 执行 PreTest hooks
  +-- 运行 [scripts].test 对应的 shell 命令
  +-- 执行 PostTest hooks
  +-- 将测试脚本的退出码向上传递
```

构建调用位于 `cli/src/lib.rs:4315-4335`。默认情况下，`anchor test` 会调用 `build`，并传入 `ignore_keys = true`。因此，`anchor test` 构建阶段不会因为 `declare_id!` 与程序 keypair 不一致而直接失败；这正是当前 ID 不一致没有被构建阶段拦截的原因之一。

### 2.3 为什么 CLI 不启动 validator

validator 计划由 `cli/src/lib.rs:4461-4470` 计算：

```rust
skip_local_validator = cli_skip_local_validator || config_skip_local_validator
```

由于配置文件中已经设置了 `skip_local_validator = true`，`run_test_suite` 收到的 `skip_local_validator` 为 `true`。`run_test_suite` 只有在下面条件成立时才启动 validator：

```rust
if is_localnet && !skip_local_validator {
    // start validator
}
```

对应代码在 `cli/src/lib.rs:4847-4883`。因此当前流程中，Anchor CLI 不会启动 validator，也不会管理测试代码自己启动的 validator。

### 2.4 为什么 CLI 不自动部署

测试前的部署计划由 `cli/src/lib.rs:4340-4353` 和 `cli/src/lib.rs:4446-4452` 决定。对于 localnet，只有 CLI 显式传入 `--skip-local-validator` 时，当前版本的 `should_predeploy_before_test` 才会在测试前执行部署。配置文件中的 skip 只影响 validator 启动计划，不会触发这里的 predeploy。

所以当前测试前的部署不是 Anchor CLI 完成的，而是测试代码中的：

```rust
solana program deploy ...
```

### 2.5 测试脚本如何执行

`run_test_suite` 在 `cli/src/lib.rs:4911-4930` 中取出脚本并执行：

```rust
std::process::Command::new("bash")
    .arg("-c")
    .arg(script_args)
    .env("ANCHOR_PROVIDER_URL", url)
    .env("ANCHOR_WALLET", cfg.provider.wallet.to_string())
```

当前脚本字符串是 `cargo test`，所以实际执行的是：

```text
bash -c "cargo test"
```

`ANCHOR_PROVIDER_URL` 和 `ANCHOR_WALLET` 会被传入子进程，但当前 Rust 测试没有读取这些环境变量，而是直接使用固定的 `http://localhost:8899` 和自己生成的 `Keypair`。

测试命令的退出码在 `cli/src/lib.rs:4967-4977` 处理。`cargo test` 失败时，Anchor CLI 最终返回非零状态。

## 3. 构建与 IDL 生成阶段

### 3.1 SBF 构建

Anchor 的 `build` 函数从 `cli/src/lib.rs:2274` 开始。对于当前根目录存在 `Cargo.toml` 的 workspace，最终会进入 `build_all` 或 `build_cwd`，并执行 `cargo build-sbf`。核心执行点在 `_build_cwd`：

- `cli/src/lib.rs:3003-3022`：执行 `cargo build-sbf`；
- `cli/src/lib.rs:3024-3066`：构建成功后生成 IDL、TypeScript 类型文件和错误常量文件。

程序 crate 的 `crate-type = ["cdylib", "lib"]` 使构建产物可以作为 Solana 程序部署，同时保留普通 Rust library 供集成测试引用。

### 3.2 IDL 和 TypeScript 文件

`generate_idl` 位于 `cli/src/lib.rs:3551-3582`，使用 `anchor_lang_idl::build::IdlBuilder` 根据程序和账户宏生成 IDL。生成结果写入：

- `target/idl/my_project.json`
- `target/types/my_project.ts`

TypeScript 文件只是 IDL 的 camelCase 类型辅助文件，相关说明和生成逻辑在 `cli/src/lib.rs:3791-3807`。当前工程没有 TypeScript 测试目录，因此这个文件在本次 Rust 测试中没有被消费。

生成的 IDL 明确列出了两个 instruction：

- `increment`：`target/idl/my_project.json:9-48`
- `initialize`：`target/idl/my_project.json:51-93`

`initialize` 的 instruction discriminator 是：

```text
[175, 175, 109, 31, 13, 152, 155, 237]
```

账户 `Counter` 的 discriminator 位于 `target/idl/my_project.json:96-109`。

## 4. Rust 集成测试的执行路径

测试主体位于 `programs/my-project/tests/test_initialize.rs:15-88`。

### 4.1 启动 validator

代码在 `test_initialize.rs:18-25`：

```rust
let mut validator = Command::new("solana-test-validator")
    .arg("--ledger")
    .arg("/tmp/solana-test-validator")
    .spawn()?;

sleep(Duration::from_secs(5));
```

这里有几个重要行为：

1. `spawn()` 只负责启动子进程，不等待 RPC 可用；
2. 固定等待 5 秒，不检查 health、slot 或 RPC；
3. 使用固定 ledger `/tmp/solana-test-validator`，没有 `--reset`，也没有使用临时目录；
4. 如果测试在中间 panic 或 assert 失败，`validator.kill()` 不会执行。

实测启动已有 ledger 时，validator 输出了：

```text
--faucet-sol argument ignored, ledger already exists
Ledger location: /tmp/solana-test-validator
```

这说明测试复用了旧 ledger，测试不是从一个确定的空状态开始。

### 4.2 计算程序 ID 和 Counter PDA

`test_initialize.rs:27-33`：

```rust
let program_id = my_project::id();
let payer = Keypair::new();
let counter = Pubkey::find_program_address(
    &[my_project::constants::COUNTER_SEED],
    &program_id,
).0;
```

`my_project::id()` 来自 `declare_id!`，当前为 `7zTre...`。`COUNTER_SEED` 是 `b"counter"`，定义在 `programs/my-project/src/constants.rs:3-4`。

`find_program_address` 返回 `(Pubkey, bump)`，这里只取地址，丢弃 bump。对于当前固定 seed 的初始化场景，测试计算地址本身没有问题；但 Anchor 链上约束会独立计算 canonical PDA 并校验传入账户地址。

### 4.3 部署程序

`test_initialize.rs:35-41` 执行：

```rust
solana program deploy \
  /home/quant/work/solana/my-project/target/deploy/my_project.so \
  --url http://localhost:8899
```

这段代码只检查 `deploy.status.success()`，然后打印 `Program deployed`。它没有：

- 读取 `solana program deploy` 输出中的实际 Program ID；
- 检查部署地址是否等于 `program_id`；
- 检查链上程序 owner、upgrade authority 或 executable 状态；
- 显式指定 program keypair。

#### 当前的程序 ID 不一致

只读检查结果：

| 来源 | 地址 |
| --- | --- |
| `programs/my-project/src/lib.rs:12` 的 `declare_id!` | `7zTre5vf7e6SunLpxZiTALuF2uGLspo6eWwx41PpHKTy` |
| `Anchor.toml:9-10` | `7zTre5vf7e6SunLpxZiTALuF2uGLspo6eWwx41PpHKTy` |
| `target/deploy/my_project-keypair.json` | `8ikay7TRNuyuyL38GnNfTQmcj2uuxnUDvaBWcUbgw4XS` |
| 当前 Solana CLI 默认配置钱包 | `CCHALZe5JSAYkGfAmMprsN3NNbqgKUqLynKHEoZy9G9L` |

`anchor keys list` 也显示 `my_project` 的实际程序 keypair 是 `8ikay...`。`solana program deploy --help` 说明，未指定 `--program-id` 时会使用对应 `program-keypair.json` 的地址作为程序地址。

因此，测试中的 `program_id` 是 `7zTre...`，而默认部署规则很可能把程序部署到 `8ikay...`。更严重的是，程序二进制内部由 `declare_id!` 固定为 `7zTre...`。Anchor 生成的入口会在运行时检查：

```text
传入的 program_id == 程序编译时的 ID
```

如果二进制被部署到 `8ikay...`，即使 instruction 指向 `8ikay...`，入口仍会因为 `DeclaredProgramIdMismatch` 失败。测试没有暴露这个问题，因为它在 airdrop 阶段提前失败了。

### 4.4 Airdrop 失败

`test_initialize.rs:43-49`：

```rust
solana airdrop 1000000000 <payer-pubkey> --url http://localhost:8899
```

`solana airdrop` 的 `<AMOUNT>` 单位是 SOL，不是 lamports。当前参数等价于请求 10 亿 SOL。当前本地 validator 的 faucet 余额不足以支付这个请求，实测错误为：

```text
Airdrop failed: Error: account does not have enough SOL to perform the operation
```

因此当前实测流程在 `test_initialize.rs:48` 终止，后续 instruction 构造、账户查询和 validator 清理都没有执行。

如果目标是给随机 payer 1 SOL，CLI 参数应为：

```text
solana airdrop 1 <payer-pubkey> --url http://localhost:8899
```

如果要使用 lamports，应改用 Solana RPC client 的 airdrop API，而不是把 lamports 数字直接传给 `solana airdrop`。

### 4.5 构造 Anchor instruction

`test_initialize.rs:51-62` 构造了一个原始 Solana instruction：

```rust
Instruction::new_with_bytes(
    program_id,
    &my_project::instruction::Initialize {}.data(),
    my_project::accounts::Initialize {
        payer: payer.pubkey(),
        counter,
        system_program: system_program::ID,
    }
    .to_account_metas(None),
)
```

这里涉及三层生成代码：

1. `InstructionData::data()` 会写入 instruction discriminator，再 Borsh 序列化参数。`initialize` 没有参数，所以数据长度为 8 字节，内容是 IDL 中的 initialize discriminator。
2. `my_project::accounts::Initialize` 是由 `#[derive(Accounts)]` 生成的客户端账户结构。
3. `ToAccountMetas` 由 Anchor 根据账户约束生成。`payer` 被标记为 signer 和 writable，`counter` 被标记为 writable，`system_program` 是只读系统程序账户。

生成的 instruction account metas 逻辑对应 Anchor 源码：

- `lang/syn/src/codegen/accounts/to_account_metas.rs:6-53`
- `lang/src/lib.rs:371-380` 的 `InstructionData::data`

但是，这段代码只是构造内存中的 `Instruction`，没有创建 blockhash、transaction、签名或 RPC 请求。

### 4.6 查询和所谓的运行程序

测试随后执行两次 `solana account`：

- 初始化前：`test_initialize.rs:64-69`
- 初始化后：`test_initialize.rs:78-83`

两次命令都没有检查 `status.success()`，也没有解析账户数据。初始化前账户不存在是预期状态，但当前代码把命令输出直接打印出来，无法形成有效断言。

初始化 instruction 原本应在 `test_initialize.rs:71-76` 发送：

```rust
solana program run <program_id> --url http://localhost:8899
```

在当前安装的 Solana CLI 4.1.2 中，`solana program` 只有 `close`、`deploy`、`dump`、`extend`、`show`、`upgrade`、`write-buffer` 等子命令，没有 `run` 子命令。因此即使 airdrop 成功，这一步也会失败。

此外，这个命令没有接收前面构造的 `instruction`，也没有 payer signer，无法表达一个 Anchor instruction 所需的 transaction。`ix_result` 只打印 stdout，不检查 exit status，也不打印 stderr；如果命令失败，测试仍可能继续。

### 4.7 清理逻辑

测试只在最后执行：

```rust
validator.kill().unwrap();
```

对应 `test_initialize.rs:85-88`。由于前面的 airdrop assert 已经 panic，当前实测没有到达清理代码，validator 进程会残留。代码也没有：

- `Drop` guard；
- `wait()`；
- 对 `kill()` 失败的处理；
- 删除或隔离 ledger；
- 对端口冲突的处理。

本次复现结束后，测试启动的 validator 进程需要手动终止。

## 5. 链上程序的实际执行路径

### 5.1 Anchor 生成的入口

源码入口在 `programs/my-project/src/lib.rs:12-24`：

```rust
declare_id!("7zTre...");

#[program]
pub mod my_project {
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx)
    }

    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        crate::instructions::increment::handle_increment(ctx)
    }
}
```

`#[program]` 宏生成的入口逻辑在 Anchor 源码 `lang/syn/src/codegen/program/entry.rs:9-66`。运行时流程是：

1. Solana runtime 调用生成的 `entry`；
2. 检查传入 `program_id` 是否等于编译期 `ID`；
3. 调用 dispatch；
4. 根据 instruction data 前 8 字节匹配 `initialize` 或 `increment`；
5. 进入对应 handler wrapper。

dispatch 代码在 `lang/syn/src/codegen/program/dispatch.rs:4-29` 和 `:70-96`。对当前 instruction 来说，匹配条件是：

```rust
if data.starts_with(instruction::Initialize::DISCRIMINATOR) {
    // 调用 initialize wrapper
}
```

### 5.2 Handler wrapper 和账户校验

handler wrapper 的生成逻辑在 `lang/syn/src/codegen/program/handlers.rs:107-178`，顺序为：

1. 反序列化 instruction 参数；
2. 创建 bump 和 realloc 状态；
3. 调用 `Initialize::try_accounts`；
4. 执行账户约束；
5. 构造 `Context`；
6. 调用用户写的 `handle_initialize`；
7. 调用 `__accounts.exit` 持久化可变账户。

`#[derive(Accounts)]` 生成的 `try_accounts`、约束和 exit 逻辑分别由：

- `lang/syn/src/codegen/accounts/try_accounts.rs:247-307`
- `lang/syn/src/codegen/accounts/constraints.rs`
- `lang/syn/src/codegen/accounts/exit.rs:10-81`

生成。

### 5.3 `initialize` 的账户约束

`programs/my-project/src/instructions/initialize.rs:5-18` 定义：

```rust
#[account(mut)]
pub payer: Signer<'info>,

#[account(
    init,
    payer = payer,
    space = 8 + Counter::INIT_SPACE,
    seeds = [COUNTER_SEED],
    bump
)]
pub counter: Account<'info, Counter>,

pub system_program: Program<'info, System>,
```

链上校验和初始化包括：

- `payer` 必须是 signer，且账户可变；
- `counter` 必须是由 `[b"counter"]` 和当前程序 ID 推导出的 canonical PDA；
- Anchor 通过 system program 创建账户；
- 新账户 owner 是当前程序；
- 初始空间为 `8 + Counter::INIT_SPACE`；
- Anchor 为账户转入 rent-exempt 所需 lamports；
- `counter` 初始数据先按未检查方式转换为 `Account<Counter>`，随后 handler 写入业务字段。

Anchor 对 `init + seeds + bump` 的生成代码在 `lang/syn/src/codegen/accounts/constraints.rs:507-621`，system program 创建账户的生成代码在 `:1120-1215` 和 `:1778-1813`。

### 5.4 业务 handler

`handle_initialize` 位于 `programs/my-project/src/instructions/initialize.rs:20-32`：

```rust
ctx.accounts.counter.count = 0;
ctx.accounts.counter.authority = ctx.accounts.payer.key();

anchor_lang::system_program::transfer(
    CpiContext::new(system_program::ID, cpi_accounts),
    HELLO_WORLD_LAMPORTS,
)?;
```

执行结果是：

- `count = 0`；
- `authority = payer`；
- 再从 payer 向 counter 转入 1 lamport；
- 输出日志 `Hello, world! Counter initialized`。

`Counter` 定义在 `programs/my-project/src/state.rs:3-8`：

```rust
pub struct Counter {
    pub count: u64,
    pub authority: Pubkey,
}
```

`u64` 占 8 字节，`Pubkey` 占 32 字节，所以 `Counter::INIT_SPACE = 40`。Anchor 账户数据还要加 8 字节账户 discriminator，最终账户数据长度为 48 字节。

handler 返回后，`counter` 因为声明为 `mut`，会在 `AccountsExit` 阶段重新序列化回账户数据。

### 5.5 `increment` 为什么没有执行

`increment` 定义在 `programs/my-project/src/instructions/increment.rs:5-25`。它会校验：

- counter 是由 `b"counter"` 推导的 PDA；
- authority 与账户中保存的 authority 相等；
- count 尚未达到 `MAX_COUNT = 10`；
- count 加一。

当前测试只尝试 initialize，没有构造或发送 increment instruction，因此这部分链上逻辑没有被覆盖。

## 6. 实测结果

使用 `anchor test --skip-build` 复现时，CLI 阶段输出：

```text
Found a 'test' script in the Anchor.toml. Running it as a test suite!
Running test suite: ".../Anchor.toml"
```

Cargo 编译成功，但出现：

```text
warning: unused import: `AccountDeserialize`
```

随后进入集成测试：

```text
running 1 test
✓ Program deployed
thread 'test_initialize' panicked at programs/my-project/tests/test_initialize.rs:48:5:
Airdrop failed: Error: account does not have enough SOL to perform the operation
```

最终状态：

| 阶段 | 结果 |
| --- | --- |
| Anchor CLI 进入测试脚本 | 成功 |
| Rust 测试编译 | 成功，有一个 unused import warning |
| validator 启动 | 成功，但复用了已有 ledger |
| `solana program deploy` | 子进程返回成功，但没有验证实际 Program ID |
| airdrop | 失败，测试在 `test_initialize.rs:48` panic |
| Anchor instruction 发送 | 未执行 |
| counter 状态断言 | 未执行 |
| validator 清理 | 未执行，失败路径遗漏清理 |

## 7. 问题与修复建议

按对测试有效性的影响排序：

### P0：同步程序 ID

当前至少存在三个不同地址：`declare_id!` / `Anchor.toml` 的 `7zTre...`、程序 keypair 的 `8ikay...`、Solana CLI 默认钱包的 `CCHAL...`。

建议先选择唯一程序 ID，然后同步：

1. 使用 `anchor keys sync` 将源码和配置同步到实际程序 keypair；或
2. 重新生成/替换程序 keypair，并同步 `declare_id!`、`Anchor.toml` 和部署命令；
3. 部署时显式传入 program keypair 或 `--program-id`；
4. 部署后断言链上地址等于测试使用的 `program_id`。

不要在测试中同时使用一个编译期 ID、一个部署 ID 和一个 instruction ID。

### P0：修正 airdrop 单位

将：

```rust
.args(["airdrop", "1000000000", ...])
```

改为：

```rust
.args(["airdrop", "1", ...])
```

如果确实要表达 lamports，应使用 RPC client API，不要把它传给 Solana CLI 的 SOL 参数。

### P0：用真实交易发送 instruction

`Instruction` 构造出来后，需要：

1. 获取 recent blockhash；
2. 构造 `Transaction::new_signed_with_payer`；
3. 使用 payer `Keypair` 签名；
4. 通过 `RpcClient` 发送并确认交易；
5. 检查 transaction result 和 account 状态。

`solana program run` 不能替代这个过程。当前 Solana CLI 4.1.2 没有这个子命令。

### P1：验证部署结果

不要只检查 deploy 子进程的退出码。至少应：

- 捕获并解析 `Program ID`；
- 检查 `program_id == deployed_program_id`；
- 使用 `solana program show` 或 RPC `get_account` 检查程序账户；
- 检查程序 owner 是 BPF Upgradeable Loader；
- 检查 upgrade authority 是否符合预期。

### P1：让 validator 生命周期可重复

建议使用每次测试唯一的临时 ledger，或者在固定 ledger 上显式使用 `--reset`。启动后应轮询 RPC health 或 `cluster-version`，不要依赖固定 5 秒 sleep。

清理应放在 `Drop` guard 中，确保以下情况都会执行：

- assertion panic；
- command 失败；
- test timeout；
- 多个测试并行运行。

同时不要忽略 `kill()` 和 `wait()` 的结果。

### P1：增加状态断言

当前两次 `solana account` 都没有检查命令状态，也没有解析数据。至少应断言：

- 初始化前账户不存在或处于预期状态；
- 初始化交易成功；
- 初始化后账户 owner 正确；
- 数据长度至少为 48 字节；
- 前 8 字节是 Counter discriminator；
- `count == 0`；
- `authority == payer.pubkey()`；
- lamports 满足 rent-exempt 加额外 1 lamport 的预期。

### P1：统一路径和钱包

部署路径在 `test_initialize.rs:37` 被硬编码为绝对路径。建议使用 workspace 相对路径或从 `CARGO_MANIFEST_DIR` 推导 `target/deploy/my_project.so`。

当前环境的 Solana CLI 默认 keypair 恰好是 `~/.config/solana/id.json`，与 Anchor provider wallet 相同，但测试代码没有显式保证这一点。部署命令应显式传入 keypair，或在测试中读取 `ANCHOR_WALLET` 并校验路径。

### P2：清理测试代码

- 删除未使用的 `AccountDeserialize` import；
- 集成测试不需要自定义 `fn main() {}`；
- 对 `deploy`、`airdrop`、`account`、instruction 发送命令同时检查 stdout、stderr 和 exit status；
- 当前测试只覆盖 initialize，测试名称和断言应明确这一点，另加 increment 的独立测试。

## 8. 代码与生成机制索引

| 主题 | 项目代码 | Anchor 生成/CLI 代码 |
| --- | --- | --- |
| Anchor test 配置 | `Anchor.toml:1-17` | `cli/src/lib.rs:4251-4470` |
| 测试脚本执行 | `Anchor.toml:16-17` | `cli/src/lib.rs:4911-4930` |
| SBF 构建 | `programs/my-project/Cargo.toml:8-24` | `cli/src/lib.rs:2274-2405`, `:3003-3022` |
| IDL 生成 | `programs/my-project/Cargo.toml:17` | `cli/src/lib.rs:3551-3582`, `:3791-3807` |
| 程序入口 | `programs/my-project/src/lib.rs:12-24` | `lang/syn/src/codegen/program/entry.rs:9-66` |
| instruction dispatch | `target/idl/my_project.json:51-61` | `lang/syn/src/codegen/program/dispatch.rs:4-29` |
| instruction 数据 | `test_initialize.rs:51-62` | `lang/src/lib.rs:371-380` |
| 账户 metas | `test_initialize.rs:55-61` | `lang/syn/src/codegen/accounts/to_account_metas.rs:6-53` |
| 账户校验 | `instructions/initialize.rs:5-18` | `lang/syn/src/codegen/accounts/try_accounts.rs:247-307` |
| PDA 和初始化 | `instructions/initialize.rs:9-16` | `lang/syn/src/codegen/accounts/constraints.rs:507-621`, `:1120-1215` |
| 账户序列化退出 | `state.rs:3-8` | `lang/syn/src/codegen/accounts/exit.rs:10-81` |
| 业务 handler | `instructions/initialize.rs:20-32` | `lang/syn/src/codegen/program/handlers.rs:143-178` |

Anchor CLI 源码路径基于当前环境中的 checkout：

```text
/home/quant/.cargo/git/checkouts/anchor-0977bcaec406b76e/1eb46ec
```

## 9. 最终判断

当前 `anchor test` 的真实执行链是：

```text
Anchor CLI
  -> SBF build + IDL generation
  -> 由于 skip_local_validator=true，不启动 CLI validator
  -> bash -c "cargo test"
       -> 测试自己启动 validator
       -> 测试自己部署 .so
       -> airdrop 失败
       -> initialize instruction 从未发送
```

因此，当前测试失败并不是 Anchor 程序 handler 的业务逻辑失败，而是测试基础设施和测试脚本本身的问题。要得到有意义的 initialize 测试，必须先解决程序 ID 同步、airdrop 单位、真实 transaction 发送、validator 生命周期和状态断言这五类问题。
