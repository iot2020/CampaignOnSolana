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
fn test_initialize() {
    let client = RpcClient::new("http://127.0.0.1:8899".to_string());
    let program_id = Address::from(my_project::id().to_bytes());
    let payer_path = std::env::var("ANCHOR_WALLET")
        .unwrap_or_else(|_| format!("{}/.config/solana/id.json", std::env::var("HOME").unwrap()));
    let payer = read_keypair_file(payer_path).expect("Failed to read provider wallet");
    let payer_pubkey = Pubkey::new_from_array(payer.pubkey().to_bytes());
    let counter_pubkey = Pubkey::find_program_address(
        &[my_project::constants::COUNTER_SEED],
        &my_project::id(),
    )
    .0;
    let counter = Address::from(counter_pubkey.to_bytes());
    assert!(client.get_balance(&payer.pubkey()).expect("Failed to query payer balance") > 0);

    if let Ok(account) = client.get_account(&counter) {
        let mut account_data = account.data.as_slice();
        let counter_account = my_project::state::Counter::try_deserialize(&mut account_data)
            .expect("Failed to deserialize existing Counter account");
        assert_eq!(counter_account.count, 0);
        assert_eq!(counter_account.authority, payer_pubkey);
        return;
    }

    let anchor_instruction = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        my_project::id(),
        &my_project::instruction::Initialize {}.data(),
        my_project::accounts::Initialize {
            payer: payer_pubkey,
            counter: counter_pubkey,
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
        .get_account(&counter)
        .expect("Failed to fetch Counter account");
    let mut account_data = account.data.as_slice();
    let counter_account = my_project::state::Counter::try_deserialize(&mut account_data)
        .expect("Failed to deserialize Counter account");

    assert_eq!(counter_account.count, 0);
    assert_eq!(counter_account.authority, payer_pubkey);
}
