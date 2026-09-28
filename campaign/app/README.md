# Third-party donate client

This CLI sends a `Donate` instruction using the wallet in `ANCHOR_WALLET`. The Campaign PDA is derived from the campaign admin public key, so the donor wallet can be a different account.

Start a local validator and deploy the program first:

```bash
solana-test-validator -r
anchor program deploy --provider.cluster localnet
```

Create a Campaign with the existing integration test or another client. Then create a separate donor wallet and fund it:

```bash
solana-keygen new --no-bip39-passphrase -o /tmp/donor.json
solana airdrop 2 $(solana address -k /tmp/donor.json) --url http://127.0.0.1:8899
```

Set the donor wallet and pass the Campaign admin public key. The amount is in lamports:

```bash
export ANCHOR_WALLET=/tmp/donor.json
cargo run --manifest-path app/Cargo.toml -- \
  "<campaign-admin-pubkey>" \
  100
```

The client prints the donor, Campaign address, transaction signature, and `amount_raised` before and after the donation. The Campaign must already exist, and its deadline must not have passed.
