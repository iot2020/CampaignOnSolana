# CampaignOnSolana

A Solana-based crowdfunding campaign dApp consisting of two main parts:

1. **On-chain program** – an Anchor-written Solana program (`campaign/`) that allows creating campaigns, donating, and extending campaign duration.
2. **Off-chain browser extension wallet** – `wallet/` provides a minimal Solana browser wallet (Side Panel) for signing transactions and interacting with the on-chain program.

Together they form a complete dApp experience: users can create campaigns, donate SOL, and the wallet handles signing and sending transactions.

---

## Table of Contents

- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [On-chain Program (Anchor)](#on-chain-program-anchor)
  - [Setup](#setup--prerequisites-for-anchor)
  - [Build & Test](#build--test)
  - [Deploy](#deploy)
- [Browser Extension Wallet](#browser-extension-wallet)
  - [Setup](#setup--prerequisites-for-wallet)
  - [Build & Run](#build--run)
  - [Usage](#usage)
- [Interacting with the Program](#interacting-with-the-program)
- [Development Workflow](#development-workflow)
- [License](#license)

---

## Project Structure

```
CampaignOnSolana/
├── campaign/              # Anchor Solana program
│   ├── Anchor.toml
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── programs/my-project/   # Rust program source
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   └── tests/
│   └── ...
├── wallet/                # Minimal Solana browser extension wallet (Vite + React)
│   ├── package.json
│   ├── vite.config.js
│   ├── src/               # Wallet source
│   ├── public/
│   └── dist/              # Built output
└── README.md              # This file
```

---

## Prerequisites

- [Rust toolchain](https://www.rust-lang.org/tools) (including `cargo` and `anchor`), tested with `rust-toolchain.toml` (currently 1.89.0).
- [Node.js 20+] and [pnpm] (or `npm`) for the wallet.
- [Google Chrome/Edge 114+] for the Side Panel API (the wallet uses `chrome.sidePanel`).
- A Solana devnet cluster endpoint (default in `Anchor.toml`).

---

## On-chain Program (Anchor)

### Setup

```bash
# From the repo root
cd campaign
anchor build    # compiles the program & generates IDL
```

The program ID is defined in `programs/my-project/src/lib.rs`:

```
8ikay7TRNuyuyL38GnNfTQmcj2uuxnUDvaBWcUbgw4XS
```

Configure the provider wallet and cluster in `Anchor.toml` (devnet by default).

### Build & Test

```bash
cd campaign
anchor build       # compile program
anchor test        # run tests (if any)
```

Individual test scripts and analysis files exist under `campaign/` (e.g., `ANCHOR_TEST_EXECUTION_ANALYSIS.md`, `SOLANA_BEGINNER_TEST_GUIDE.md`).

### Deploy

```bash
anchor deploy
```

After deployment, update the program ID in `lib.rs` if you use a different address, and update the devnet configuration in `Anchor.toml` accordingly.

---

## Browser Extension Wallet

### Setup

```bash
cd wallet
pnpm install       # or npm install
```

The wallet is a Vite‑React project. It uses `chrome.sidePanel` (Chrome/Edge 114+). A fixed `manifest.key` guarantees a stable extension ID so that `chrome.storage.local` persists across reinstalls.

### Build & Run

```bash
# Install dependencies
pnpm install

# Development mode (loads unpacked extension; watch mode)
pnpm run dev

# Production build
pnpm run build     # outputs to dist/
```

**Development loading**

1. Build: `pnpm run build`
2. In Chrome/Edge: `chrome://extensions → Developer mode → Load unpacked → select dist/`
3. The extension ID will be `gbkhjkllidmdjheioadjnpebiohlhfoc` (fixed by `manifest.key`).

### Usage

After loading the extension:

1. **Create Wallet** – set a local password; the secret key is encrypted with PBKDF2 + AES‑256‑GCM.
2. **Select Network** – Devnet (default) or Mainnet.
3. **Devnet Faucet** – click “Airdrop 1 SOL” to fund the wallet.
4. **Connect to DApp** – the wallet exposes the Wallet Standard API; DApps can discover it via `window.solana`.
5. **Donate / Interact** – when a DApp (or the campaign UI) asks to sign a transaction, the wallet's Side Panel opens, the user reviews and signs, then the transaction is sent to the network.

The wallet also supports **Import/Export** of secret keys, enabling migration between machines without losing the associated address.

Details of the wallet's concepts, architecture, and edge cases are documented in `wallet/README.md` (the extensive inline docs you just read).

---

## Interacting with the Program

The wallet can sign and send transactions to the on-chain program. Typical flow:

1. User clicks **Connect** in the dApp UI.
2. The wallet receives a `signTransaction` or `signAndSendTransaction` request (Wallet Standard).
3. The Side Panel opens; the user unlocks the wallet with the password.
4. The wallet deserializes the transaction (supports both legacy and v0 messages) and signs it.
5. The signed transaction is broadcast to the Solana RPC.
6. Result (success/failure) is shown in the wallet UI.

The program instructions currently supported:

| Instruction | Params | Description |
|-------------|--------|-------------|
| `initialize` | – | Initialize an account (campaign manager). |
| `increment` | – | Increment a counter (example). |
| `create_campaign` | name, description, target_amount, duration | Create a new fundraising campaign. |
| `donate` | amount | Donate SOL to the current campaign. |
| `extend_campaign` | duration | Extend the campaign's deadline. |

Developers can call these instructions via the wallet (or any Solana client). The program ID on devnet is `8ikay7TRNuyuyL38GnNfTQmcj2uuxnUDvaBWcUbgw4XS`.

---

## Development Workflow

1. **On-chain changes** – edit Rust code under `campaign/programs/my-project/src/`, run `anchor build` and `anchor test`.
2. **Wallet changes** – edit `wallet/src/`, `vite.config.js`, etc. Run `pnpm run build` and reload the unpacked extension.
3. **Integration testing** – use the wallet's built‑in test scripts (`scripts/test-tx.mjs`, `scripts/test-keys.mjs`) to validate transaction parsing and key handling without needing Chrome APIs.
4. **End‑to‑end** – load the wallet, connect to a devnet DApp (or the campaign UI if provided), perform donate/extend actions, and verify on‑chain state with `anchor view` or `solana program show`.

---

## License

This project is licensed under the MIT License (see individual directories for any third‑party licenses).

---

## Acknowledgments

- Anchor framework for Solana program development.
- Wallet Standard for cross‑wallet transaction signing.
- Inspired by various minimal Solana wallet implementations and the Solana ecosystem best practices.