use anchor_lang::prelude::*;

use crate::state::Campaign;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct ExtendCampaign<'info>{
    #[account(
        mut,
        has_one = admin,
    )]
    pub campaign: Account<'info, Campaign>,
    pub admin: Signer<'info>,
}

pub fn handle_extend_campaign(
    ctx: Context<ExtendCampaign>,
    duration: i64
) -> Result<()> {
    require!(duration>0, ErrorCode::InvalidDuration);
    let campaign = &mut ctx.accounts.campaign;
    let clock = Clock::get()?;
    campaign.deadline = clock.unix_timestamp + duration;
    msg!("众筹项目延长成功! 项目名: {}, 新截止时间: {}", campaign.name, campaign.deadline);
    Ok(())
}