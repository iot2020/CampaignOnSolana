use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas},
    solana_address::Address,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::read_keypair_file,
    solana_message::Message,
    solana_rpc_client::rpc_client::RpcClient,
    solana_signer::Signer,
    solana_transaction::Transaction,
};

#[test]
fn test_create() {
    let client = RpcClient::new("http://127.0.0.1:8899".to_string());
    let program_id = Address::from(my_project::id().to_bytes());
    let payer_path = std::env::var("ANCHOR_WALLET")
        .unwrap_or_else(|_| format!("{}/.config/solana/id.json", std::env::var("HOME").unwrap()));
    let payer = read_keypair_file(payer_path).expect("Failed to read provider wallet");
    let payer_pubkey = Pubkey::new_from_array(payer.pubkey().to_bytes());
    let campaign_pubkey = Pubkey::find_program_address(
        &[my_project::constants::CAMP_SEED, payer_pubkey.as_ref()],
        &my_project::id(),
    )
    .0;
    let campaign = Address::from(campaign_pubkey.to_bytes());
    assert!(client.get_balance(&payer.pubkey()).expect("Failed to query payer balance") > 0);

    if let Ok(account) = client.get_account(&campaign) {
        let mut account_data = account.data.as_slice();
        let campaign_account = my_project::state::Campaign::try_deserialize(&mut account_data)
            .expect("Failed to deserialize existing Campaign account");
        assert_eq!(campaign_account.admin, payer_pubkey);
        assert_eq!(campaign_account.name, "Test campaign");
        assert_eq!(campaign_account.description, "Campaign created by integration test");
        assert_eq!(campaign_account.amount_raised, 0);
        assert_eq!(campaign_account.target_amount, 1_000_000);
        return;
    }

    let anchor_instruction = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        my_project::id(),
        &my_project::instruction::CreateCampaign {
            name: "Test campaign".to_string(),
            description: "Campaign created by integration test".to_string(),
            target_amount: 1_000_000,
            duration: 86_400,
        }
        .data(),
        my_project::accounts::CreateCampaign {
            campaign: campaign_pubkey,
            user: payer_pubkey,            
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let instruction = Instruction {
        program_id,
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
        &[&payer],
        Message::new(&[instruction], Some(&payer.pubkey())),
        client
            .get_latest_blockhash()
            .expect("Failed to get recent blockhash"),
    );
    client
        .send_and_confirm_transaction(&transaction)
        .expect("Initialize transaction failed");

    let account = client
        .get_account(&campaign)
        .expect("Failed to fetch Campaign account");
    let mut account_data = account.data.as_slice();
    let campaign_account = my_project::state::Campaign::try_deserialize(&mut account_data)
        .expect("Failed to deserialize Campaign account");

    assert_eq!(campaign_account.admin, payer_pubkey);
    assert_eq!(campaign_account.name, "Test campaign");
    assert_eq!(campaign_account.description, "Campaign created by integration test");
    assert_eq!(campaign_account.amount_raised, 0);
    assert_eq!(campaign_account.target_amount, 1_000_000);
}
