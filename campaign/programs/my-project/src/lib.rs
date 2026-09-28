pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("8ikay7TRNuyuyL38GnNfTQmcj2uuxnUDvaBWcUbgw4XS");

#[program]
pub mod my_project {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx)
    }

    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        crate::instructions::increment::handle_increment(ctx)
    }

    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        name: String,
        description: String,
        target_amount: u64,
        duration: i64
    ) -> Result<()> {
        crate::instructions::create_campaign::handle_create_campaign(
            ctx,
            name,
            description,
            target_amount,
            duration
        )
    }

    pub fn donate(ctx: Context<Donate>, amount: u64) -> Result<()> {
        crate::instructions::donate::handle_donate(ctx, amount)
    }

    pub fn extend_campaign(ctx: Context<ExtendCampaign>, duration: i64) -> Result<()> {
        crate::instructions::extend_campaign::handle_extend_campaign(ctx, duration)
    }
}
