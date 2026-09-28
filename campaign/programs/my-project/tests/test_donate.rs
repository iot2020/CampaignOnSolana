use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas},
    solana_address::Address,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::read_keypair_file,
    solana_message::Message,
    solana_rpc_client::rpc_client::RpcClient,
    solana_signer::Signer,
    solana_transaction::Transaction,
    solana_commitment_config::CommitmentConfig,
};

fn send_instruction(
    client: &RpcClient,
    payer: &solana_keypair::Keypair,
    anchor_instruction: anchor_lang::solana_program::instruction::Instruction,
) {
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
        &[payer],
        Message::new(&[instruction], Some(&payer.pubkey())),
        client
            .get_latest_blockhash()
            .expect("Failed to get recent blockhash"),
    );
    client
        .send_and_confirm_transaction(&transaction)
        .expect("Transaction failed");
}

fn read_campaign(client: &RpcClient, campaign: &Address) -> my_project::state::Campaign {
    let account = client
        .get_account(campaign)
        .expect("Failed to fetch Campaign account");
    let mut campaign_data = account.data.as_slice();
    my_project::state::Campaign::try_deserialize(&mut campaign_data)
        .expect("Failed to deserialize Campaign account")
}

fn campaign_exists(client: &RpcClient, campaign: &Address) -> bool {
    match client.get_account_with_commitment(
        campaign,
        CommitmentConfig::confirmed(),
    ) {
        Ok(response) => response.value.is_some(),

        Err(err) => {
            panic!(
                "Failed to query Campaign account {}: {:?}",
                campaign, err
            );
        }
    }
}

#[test]
fn test_donate() {
    let rpc_url = std::env::var("SOLANA_RPC_URL")
    .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
    let client = RpcClient::new(rpc_url);
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
    println!("test_donate payer_pubkey: {}", payer_pubkey);

    assert!(client.get_balance(&payer.pubkey()).expect("Failed to query payer balance") > 0);

    if !campaign_exists(&client, &campaign) {
        print!("test_donate Campaign no exist");
        send_instruction(
            &client,
            &payer,
            anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
                my_project::id(),
                &my_project::instruction::CreateCampaign {
                    name: "Test campaign".to_string(),
                    description: "Campaign created by integration test".to_string(),
                    target_amount: 1_000_000,
                    duration: 86_400,
                }.data(),
                my_project::accounts::CreateCampaign {
                    campaign: campaign_pubkey,
                    user: payer_pubkey,
                    system_program: anchor_lang::system_program::ID,
                }
                .to_account_metas(None),
            ),
        );
    }

    let before = read_campaign(&client, &campaign);
    assert_eq!(before.admin, payer_pubkey);
    println!("test_donate Before donation: {}", before.target_amount);
    assert_eq!(before.target_amount, 1_000_000);

    send_instruction(
        &client,
        &payer,
        anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
            my_project::id(),
            &my_project::instruction::Donate {amount: 100}.data(),
            my_project::accounts::Donate {
                campaign: campaign_pubkey,
                user: payer_pubkey,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        ),
    );

    let after = read_campaign(&client, &campaign);
    assert_eq!(after.admin, payer_pubkey);
    println!("test_donate After donation: {}", after.amount_raised);
}


#[test]
fn test_extend() {
    let rpc_url = std::env::var("SOLANA_RPC_URL")
    .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
    let client = RpcClient::new(rpc_url);
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
    println!("test_extend payer_pubkey: {}", payer_pubkey);

    assert!(client.get_balance(&payer.pubkey()).expect("Failed to query payer balance") > 0);

    if !campaign_exists(&client, &campaign) {
        print!("test_extend Campaign no exist");
        return;
    }

    println!("Campaign: {}", campaign_pubkey);

    // 延长 30 天
    let duration: i64 = 30 * 24 * 60 * 60;

    println!(
        "Extend duration: {} seconds (30 days)",
        duration
    );

    let instruction =
        anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
            my_project::id(),

            &my_project::instruction::ExtendCampaign {
                duration,
            }.data(),

            my_project::accounts::ExtendCampaign {
                campaign: campaign_pubkey,
                admin: payer_pubkey,
            }.to_account_metas(None),
        );

    send_instruction(
        &client,
        &payer,
        instruction,
    );

    println!("Extend campaign succeeded!");

}