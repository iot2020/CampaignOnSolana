import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Buffer } from 'buffer';

import {
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';

import { getWallets } from '@wallet-standard/app';

import './styles.css';

const PROGRAM_ID = new PublicKey(
    '8ikay7TRNuyuyL38GnNfTQmcj2uuxnUDvaBWcUbgw4XS'
);

const RPC_URL =
    import.meta.env.VITE_RPC_URL ||
    'http://127.0.0.1:8899';

const DONATE_DISCRIMINATOR = Uint8Array.from([
    121, 186, 218, 211,
    73, 70, 196, 180
]);

const SEED = new TextEncoder().encode('campaign');
const URL1 = 'https://devnet.helius-rpc.com/?api-key=9fff9fc2-16f6-46b1-9b9a-e760457a33ab';

function App() {
    // =========================================================
    // Wallet Standard
    // =========================================================
    const [wallet, setWallet] = useState(null);
    const [walletAccount, setWalletAccount] = useState(null);

    const [admin, setAdmin] = useState('');
    const [amount, setAmount] = useState('100');
    const [campaign, setCampaign] = useState(null);
    const [status, setStatus] =
        useState('Connect a wallet to begin.');
    const [loading, setLoading] = useState(false);

    const connection =
        new Connection(RPC_URL, 'confirmed');
    const connection1 = new Connection(URL1, 'confirmed');

    const walletRegistry = getWallets();

    // =========================================================
    // Connect Minimal Solana Wallet
    // =========================================================
    async function connectWallet() {
        try {
            const wallets = walletRegistry.get();

            console.log(
                'Wallet Standard wallets:',
                wallets
            );

            // 找我们的 Minimal Wallet
            const minimalWallet = wallets.find(
                (item) =>
                    item.name === 'Minimal Solana Wallet'
            );

            if (!minimalWallet) {
                setStatus(
                    'Minimal Solana Wallet was not found.'
                );
                return;
            }

            console.log(
                'Minimal Wallet:',
                minimalWallet
            );

            const connectFeature =
                minimalWallet.features[
                'standard:connect'
                ];

            if (!connectFeature) {
                setStatus(
                    'Wallet does not support standard:connect.'
                );
                return;
            }

            setStatus(
                'Connecting to Minimal Wallet...'
            );

            const result =
                await connectFeature.connect();

            console.log(
                'Connect result:',
                result
            );

            if (
                !result.accounts ||
                result.accounts.length === 0
            ) {
                throw new Error(
                    'Minimal Wallet returned no accounts.'
                );
            }

            const account = result.accounts[0];

            console.log(
                'Wallet account:',
                account
            );

            setWallet(minimalWallet);
            setWalletAccount(account);

            setStatus(
                `Connected ${shortKey(account.address)} `
            );

        } catch (error) {
            console.error(
                'Connect wallet failed:',
                error
            );

            setStatus(
                error.message || String(error)
            );
        }
    }

    // =========================================================
    // Load Campaign
    // =========================================================
    async function loadCampaign() {
        try {
            const adminKey =
                new PublicKey(admin.trim());

            const [campaignKey] =
                PublicKey.findProgramAddressSync(
                    [
                        SEED,
                        adminKey.toBuffer()
                    ],
                    PROGRAM_ID
                );

            const account =
                await connection1.getAccountInfo(
                    campaignKey
                );

            if (!account) {
                throw new Error(
                    'Campaign account was not found for this admin.'
                );
            }

            const decoded =
                decodeCampaign(account.data);

            setCampaign({
                address: campaignKey,
                ...decoded
            });

            setStatus('Campaign loaded.');

        } catch (error) {
            setCampaign(null);
            setStatus(
                error.message || String(error)
            );
        }
    }

    // =========================================================
    // Donate
    // =========================================================
    async function donate() {
        if (!wallet || !walletAccount) {
            return setStatus(
                'Connect the donor wallet first.'
            );
        }

        if (!campaign) {
            return setStatus(
                'Load a Campaign first.'
            );
        }

        const lamports = Number(amount);

        if (
            !Number.isSafeInteger(lamports) ||
            lamports <= 0
        ) {
            return setStatus(
                'Amount must be a positive integer in lamports.'
            );
        }

        setLoading(true);

        try {
            // =================================================
            // Wallet address
            // =================================================
            const publicKey =
                new PublicKey(walletAccount.address);

            // =================================================
            // Balance
            // =================================================
            const balance =
                await connection.getBalance(
                    publicKey
                );

            console.log(
                '=============================='
            );
            console.log(
                'Minimal Solana Wallet'
            );
            console.log(
                '=============================='
            );

            console.log(
                'Wallet:',
                wallet.name
            );

            console.log(
                'Address:',
                publicKey.toBase58()
            );

            console.log(
                'Balance:',
                balance,
                'lamports'
            );

            console.log(
                'Balance:',
                balance / 1_000_000_000,
                'SOL'
            );

            console.log(
                'RPC:',
                connection.rpcEndpoint
            );

            // =================================================
            // Anchor Donate instruction
            // =================================================
            const data =
                new Uint8Array(16);

            data.set(
                DONATE_DISCRIMINATOR,
                0
            );

            writeU64LE(
                data,
                8,
                lamports
            );

            const instruction =
                new TransactionInstruction({
                    programId: PROGRAM_ID,

                    keys: [
                        {
                            pubkey:
                                campaign.address,
                            isSigner: false,
                            isWritable: true
                        },
                        {
                            pubkey:
                                publicKey,
                            isSigner: true,
                            isWritable: true
                        },
                        {
                            pubkey:
                                SystemProgram.programId,
                            isSigner: false,
                            isWritable: false
                        }
                    ],

                    data
                });

            // =================================================
            // Transaction
            // =================================================
            const transaction =
                new Transaction()
                    .add(instruction);

            transaction.feePayer =
                publicKey;

            const {
                blockhash,
                lastValidBlockHeight
            } =
                await connection.getLatestBlockhash(
                    'confirmed'
                );

            transaction.recentBlockhash =
                blockhash;

            transaction.lastValidBlockHeight =
                lastValidBlockHeight;

            // =================================================
            // Simulation
            // =================================================
            const simulation =
                await connection.simulateTransaction(
                    transaction
                );

            console.log(
                '=============================='
            );

            console.log(
                'Simulation err:',
                simulation.value.err
            );

            console.log(
                'Simulation logs:',
                simulation.value.logs
            );

            console.log(
                'Units:',
                simulation.value.unitsConsumed
            );

            if (simulation.value.err) {
                throw new Error(
                    `Simulation failed: ${JSON.stringify(
                        simulation.value.err
                    )
                    } `
                );
            }

            // =================================================
            // Wallet Standard signTransaction
            // =================================================
            const signTransaction =
                wallet.features[
                'solana:signTransaction'
                ];

            if (!signTransaction) {
                throw new Error(
                    'Minimal Wallet does not support solana:signTransaction.'
                );
            }

            setStatus(
                'Please approve the transaction in Minimal Wallet...'
            );

            /*
             * Wallet Standard:
             *
             * transaction = serialized message
             *
             * Minimal Wallet will add the signature.
             */
            const results =
                await signTransaction.signTransaction({
                    account:
                        walletAccount,

                    transaction:
                        transaction.serializeMessage(),

                    chain:
                        'solana:devnet'
                });

            console.log(
                'Wallet Standard sign result:',
                results
            );

            if (
                !results ||
                results.length === 0
            ) {
                throw new Error(
                    'Wallet returned no signed transaction.'
                );
            }

            const signedTransaction =
                results[0].signedTransaction;

            console.log(
                'Signed transaction:',
                signedTransaction
            );

            // =================================================
            // Send transaction
            // =================================================
            setStatus(
                'Sending transaction via Devnet...'
            );

            const signature =
                await connection.sendRawTransaction(
                    signedTransaction,
                    {
                        skipPreflight: false,
                        preflightCommitment:
                            'confirmed'
                    }
                );

            console.log(
                'Transaction signature:',
                signature
            );

            // =================================================
            // Confirm
            // =================================================
            await connection.confirmTransaction(
                {
                    signature,
                    blockhash,
                    lastValidBlockHeight
                },
                'confirmed'
            );

            await loadCampaign();

            setStatus(
                `Donation confirmed! Tx: ${shortKey(signature)} `
            );

        } catch (error) {
            console.error(
                'Donation failed:',
                error
            );

            setStatus(
                error.message || String(error)
            );

        } finally {
            setLoading(false);
        }
    }

    // =========================================================
    // UI
    // =========================================================
    return (
        <main className="shell">

            <header className="topbar">

                <div className="brand">
                    <span className="mark">
                        C
                    </span>

                    <span>
                        Campaign Desk
                    </span>
                </div>

                <button
                    className="wallet-button"
                    onClick={connectWallet}
                >
                    {walletAccount
                        ? shortKey(
                            walletAccount.address
                        )
                        : 'Connect wallet'}
                </button>

            </header>

            <section className="intro">

                <p className="eyebrow">
                    THIRD-PARTY CONTRIBUTION
                </p>

                <h1>
                    Back a campaign
                    <br />
                    <em>
                        with your own wallet.
                    </em>
                </h1>

                <p className="lede">
                    Enter the campaign administrator's
                    public key, inspect the live account,
                    and send a signed donation from a
                    separate wallet.
                </p>

            </section>

            <section className="workspace">

                {/* =================================================
                    01 Campaign
                ================================================= */}

                <div className="panel form-panel">

                    <div className="panel-heading">
                        <span>01</span>
                        <h2>
                            Find campaign
                        </h2>
                    </div>

                    <label>
                        Campaign admin public key
                    </label>

                    <input
                        value={admin}
                        onChange={(event) =>
                            setAdmin(
                                event.target.value
                            )
                        }
                        placeholder="Paste the administrator address"
                        spellCheck="false"
                    />

                    <button
                        className="secondary-button"
                        onClick={loadCampaign}
                    >
                        Load campaign
                        <span>↗</span>
                    </button>

                    <div className="network">
                        <span className="online-dot" />
                        {RPC_URL}
                    </div>

                </div>

                {/* =================================================
                    02 Campaign snapshot
                ================================================= */}

                <div className="panel campaign-panel">

                    <div className="panel-heading">
                        <span>02</span>
                        <h2>
                            Campaign snapshot
                        </h2>
                    </div>

                    {campaign ? (
                        <>
                            <div className="campaign-name">
                                {campaign.name}
                            </div>

                            <p className="description">
                                {campaign.description}
                            </p>

                            <div className="stats">

                                <div>
                                    <small>
                                        Raised
                                    </small>

                                    <strong>
                                        {campaign.amountRaised.toLocaleString()}
                                        {' '}
                                        <i>◎</i>
                                    </strong>
                                </div>

                                <div>
                                    <small>
                                        Target
                                    </small>

                                    <strong>
                                        {campaign.targetAmount.toLocaleString()}
                                        {' '}
                                        <i>◎</i>
                                    </strong>
                                </div>

                            </div>

                            <div className="progress">
                                <span
                                    style={{
                                        width: `${Math.min(
                                            100,
                                            campaign.amountRaised /
                                            campaign.targetAmount *
                                            100
                                        )
                                            }% `
                                    }}
                                />
                            </div>

                            <div className="address">
                                {campaign.address.toBase58()}
                            </div>
                        </>
                    ) : (
                        <div className="empty-state">
                            Load a campaign to see
                            its current state.
                        </div>
                    )}

                </div>

                {/* =================================================
                    03 Donate
                ================================================= */}

                <div className="panel donate-panel">

                    <div className="panel-heading">
                        <span>03</span>
                        <h2>
                            Make donation
                        </h2>
                    </div>

                    <label>
                        Amount
                        <small>
                            lamports
                        </small>
                    </label>

                    <div className="amount-input">

                        <input
                            value={amount}
                            onChange={(event) =>
                                setAmount(
                                    event.target.value
                                )
                            }
                            inputMode="numeric"
                        />

                        <span>
                            ◎
                        </span>

                    </div>

                    <button
                        className="primary-button"
                        onClick={donate}
                        disabled={loading}
                    >
                        {loading
                            ? 'Confirming...'
                            : 'Donate now'}

                        <span>
                            →
                        </span>
                    </button>

                    <p className="status">
                        {status}
                    </p>

                </div>

            </section>

            <footer>
                PROGRAM
                {' '}
                <b>
                    {PROGRAM_ID.toBase58()}
                </b>

                <span>
                    DEVNET / LOCALNET READY
                </span>
            </footer>

        </main>
    );
}

// =============================================================
// Helpers
// =============================================================

function shortKey(value) {
    return `${value.slice(0, 4)}...${value.slice(-4)} `;
}

function writeU64LE(
    bytes,
    offset,
    value
) {
    let remaining = BigInt(value);

    for (
        let index = 0;
        index < 8;
        index += 1
    ) {
        bytes[offset + index] =
            Number(
                remaining & 255n
            );

        remaining >>= 8n;
    }
}

function decodeCampaign(data) {
    let offset = 8;

    const admin =
        new PublicKey(
            data.slice(
                offset,
                offset + 32
            )
        );

    offset += 32;

    const [
        name,
        afterName
    ] =
        readString(
            data,
            offset
        );

    offset = afterName;

    const [
        description,
        afterDescription
    ] =
        readString(
            data,
            offset
        );

    offset = afterDescription;

    const amountRaised =
        readU64(
            data,
            offset
        );

    offset += 8;

    const targetAmount =
        readU64(
            data,
            offset
        );

    return {
        admin,
        name,
        description,
        amountRaised,
        targetAmount
    };
}

function readString(
    data,
    offset
) {
    const length =
        readU32(
            data,
            offset
        );

    const start =
        offset + 4;

    return [
        new TextDecoder().decode(
            data.slice(
                start,
                start + length
            )
        ),
        start + length
    ];
}

function readU32(
    data,
    offset
) {
    return (
        data[offset] +
        data[offset + 1] * 256 +
        data[offset + 2] * 65536 +
        data[offset + 3] * 16777216
    );
}

function readU64(
    data,
    offset
) {
    return Number(
        new DataView(
            data.buffer,
            data.byteOffset + offset,
            8
        ).getBigUint64(
            0,
            true
        )
    );
}

createRoot(
    document.getElementById('root')
).render(
    <App />
);
