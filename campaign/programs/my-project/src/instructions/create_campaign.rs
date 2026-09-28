use anchor_lang::prelude::*;

use crate::state::Campaign;

#[derive(Accounts)]
pub struct CreateCampaign<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 360,
        seeds = [b"campaign", user.key().as_ref()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_campaign(
    ctx: Context<CreateCampaign>,
    name: String,
    description: String,
    target_amount: u64,
    duration: i64
) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    let user = &ctx.accounts.user;
    campaign.admin = user.key();
    campaign.name = name;
    campaign.description = description;
    campaign.amount_raised = 0;
    campaign.target_amount = target_amount;
    let clock = Clock::get()?;
    campaign.deadline = clock.unix_timestamp + duration;
    msg!("众筹项目创建成功! 项目名: {}", campaign.name);
    Ok(())
}
