use anchor_lang::prelude::*;

use crate::state::Campaign;

#[derive(Accounts)]
pub struct Donate<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_donate(ctx: Context<Donate>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;

    if clock.unix_timestamp > ctx.accounts.campaign.deadline {
        return err!(crate::error::ErrorCode::CampaignEnded);
    }

    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.key(),
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.campaign.to_account_info(),
        },
    );

    anchor_lang::system_program::transfer(cpi_context, amount)?;

    let campaign = &mut ctx.accounts.campaign;
    campaign.amount_raised += amount;

    msg!("感谢支持！成功捐赠了 {} Lamports", amount);
    Ok(())
}
