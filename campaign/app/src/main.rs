use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas},
    my_project::state::Campaign,
    solana_address::Address,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::read_keypair_file,
    solana_message::Message,
    solana_rpc_client::rpc_client::RpcClient,
    solana_signer::Signer,
    solana_transaction::Transaction,
};

fn main() {
    let mut args = std::env::args().skip(1);
    let admin = args
        .next()
        .expect("Usage: cargo run -- <campaign-admin-pubkey> <amount-lamports>")
        .parse::<Pubkey>()
        .expect("Invalid campaign admin public key");
    let amount = args
        .next()
        .expect("Usage: cargo run -- <campaign-admin-pubkey> <amount-lamports>")
        .parse::<u64>()
        .expect("Amount must be a non-negative integer in lamports");

    let rpc_url =
        std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8899".to_string());
    let wallet_path = std::env::var("ANCHOR_WALLET").unwrap_or_else(|_| {
        format!(
            "{}/.config/solana/id.json",
            std::env::var("HOME").expect("HOME is not set")
        )
    });
    let donor = read_keypair_file(&wallet_path).expect("Failed to read donor wallet");
    let donor_pubkey = Pubkey::new_from_array(donor.pubkey().to_bytes());
    let client = RpcClient::new(rpc_url.clone());

    let (campaign_pubkey, _) = Pubkey::find_program_address(
        &[my_project::constants::CAMP_SEED, admin.as_ref()],
        &my_project::id(),
    );
    let campaign_address = Address::from(campaign_pubkey.to_bytes());
    let before = read_campaign(&client, &campaign_address);

    let anchor_instruction = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        my_project::id(),
        &my_project::instruction::Donate { amount }.data(),
        my_project::accounts::Donate {
            campaign: campaign_pubkey,
            user: donor_pubkey,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let instruction = Instruction {
        program_id: Address::from(anchor_instruction.program_id.to_bytes()),
        accounts: anchor_instruction
            .accounts
            .into_iter()
            .map(|meta| AccountMeta {
                pubkey: Address::from(meta.pubkey.to_bytes()),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        data: anchor_instruction.data,
    };
    let transaction = Transaction::new(
        &[&donor],
        Message::new(&[instruction], Some(&donor.pubkey())),
        client
            .get_latest_blockhash()
            .expect("Failed to get recent blockhash"),
    );
    let signature = client
        .send_and_confirm_transaction(&transaction)
        .expect("Donate transaction failed");

    let after = read_campaign(&client, &campaign_address);
    println!("Donor: {}", donor.pubkey());
    println!("Campaign: {}", campaign_address);
    println!("Signature: {}", signature);
    println!(
        "Amount raised: {} -> {}",
        before.amount_raised, after.amount_raised
    );
}

fn read_campaign(client: &RpcClient, campaign: &Address) -> Campaign {
    let account = client
        .get_account(campaign)
        .expect("Campaign account does not exist");
    let mut data = account.data.as_slice();
    Campaign::try_deserialize(&mut data).expect("Failed to deserialize Campaign account")
}
