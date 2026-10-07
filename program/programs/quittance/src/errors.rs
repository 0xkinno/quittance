//! Program errors.
//!
//! Every message is written for a person, because several of these surface
//! directly in the app. They say what is wrong and what would make it right.
//! None of them apologize and none of them are vague.

use anchor_lang::prelude::*;

#[error_code]
pub enum QuittanceError {
    #[msg("A circle needs at least two members. One person saving alone is a wallet.")]
    TooFewMembers,

    #[msg("A circle holds at most 24 members. A larger group is a second circle.")]
    TooManyMembers,

    #[msg("The rotation order must list every member exactly once.")]
    InvalidRotationOrder,

    #[msg("The contribution amount must be greater than zero.")]
    ZeroContribution,

    #[msg("The cadence must be a positive number of seconds.")]
    InvalidCadence,

    #[msg("That wallet is not a member of this circle.")]
    NotAMember,

    #[msg("That member has already joined this circle.")]
    AlreadyJoined,

    #[msg("Only the circle organizer can do that.")]
    NotOrganizer,

    #[msg("Every member must join before the first round can open.")]
    CircleNotFull,

    #[msg("Rounds open in order. Open the previous round first.")]
    RoundOutOfOrder,

    #[msg("This round is closed. Contributions are recorded against an open round.")]
    RoundClosed,

    #[msg("This round is still open. Close it before paying out.")]
    RoundNotClosed,

    #[msg("This contribution has already been recorded and recorded states do not change.")]
    SlotAlreadyRecorded,

    #[msg("A settled contribution needs the money in the vault. The vault balance does not cover it.")]
    VaultShortOfCredit,

    #[msg("An escalated contribution must name the reason it escalated.")]
    MissingAmbiguityReason,

    #[msg("A reason belongs only to an escalated contribution.")]
    UnexpectedAmbiguityReason,

    #[msg("Only the organizer can resolve an escalated contribution, and the decision is recorded against them.")]
    OverrideNotByOrganizer,

    #[msg("A machine verdict is recorded by the member it belongs to.")]
    VerdictNotByMember,

    /// I3. The one the app surfaces as the reason the payout button is off.
    #[msg("This round still has contributions that have not been resolved. Nothing pays out until every one of them is settled, rejected, or marked unpaid.")]
    RoundHasOpenContributions,

    /// I4. Reached only by a second concurrent call; the first one wins.
    #[msg("This round has already paid out. A round pays out once.")]
    AlreadyDisbursed,

    #[msg("The payout must go to the member whose turn this round is.")]
    WrongRecipient,

    #[msg("The vault does not hold what this round credited. The payout is refused.")]
    VaultBelowCredited,

    #[msg("The vault must be owned by this circle's vault authority and hold the circle's mint.")]
    InvalidVault,

    #[msg("That token account does not belong to the member it claims.")]
    InvalidRecipientAccount,
}
