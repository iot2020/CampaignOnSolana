use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the counter authority can update this counter")]
    Unauthorized,
    #[msg("Counter has reached the maximum value")]
    CounterOverflow,
    #[msg("该众筹项目已经截止")]
    CampaignEnded,
    #[msg("延长时间必须大于 0")]
    InvalidDuration,
}
