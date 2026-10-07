//! # Quittance
//!
//! A rotating savings circle whose payout cannot run twice and cannot run
//! while any contribution is unresolved.
//!
//! ## What this program is responsible for, and what it is not
//!
//! This program is deliberately not the verdict machine. It cannot be: a
//! Solana program cannot read arbitrary transaction history, so it cannot
//! look at a durable nonce account's signatures and decide for itself whether
//! a member's payment landed. That decision is made off chain by a pure
//! function that anyone can re-run — see `packages/engine/src/verdict.ts` and
//! `packages/verifier`.
//!
//! What this program does is the part that must be enforced where nobody can
//! race it:
//!
//! * **I3 — terminal before payout.** `disburse` refuses while any
//!   contribution slot in the round is unresolved.
//! * **I4 — single disbursement.** `disburse` checks and sets the disbursed
//!   flag in the same instruction that moves the money, so a second
//!   concurrent call cannot interleave with the first.
//! * **I2, partially, and more strongly than the client could.**
//!   `record_contribution` will not credit a slot as settled unless the
//!   vault's own token balance already covers everything the round has
//!   credited plus this contribution. A client that lied about a settlement
//!   would have to put the money in the vault first, at which point it is
//!   not a lie. A phantom credit is therefore impossible on chain rather
//!   than merely unlikely.
//!
//! What it does **not** do, stated plainly because the gap matters:
//! `record_contribution` takes the slot's state as an argument. The program
//! verifies the money for a settlement and verifies who is allowed to assert
//! what, but it does not independently re-derive `Rejected` versus
//! `NotSent` — those two differ only in facts the program cannot see, and
//! neither one credits anything. The nonce account is stored on chain
//! precisely so that a stranger can re-derive both from chain state alone.
//! `SECURITY.md` sets out what a malicious client can and cannot achieve
//! through this seam.
//!
//! ## The rule
//!
//! The phone records intent. The chain decides truth. The phone is never
//! allowed to be the authority on whether money moved.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod errors;
pub mod state;

use errors::QuittanceError;
use state::*;

declare_id!("BXFpbaNWBy2ZJeQLE3bhRSSRfBqZgP3CVTtFoxCqyvFP");

/// Seeds. Every account this program owns is a PDA, so there is no account
/// whose address a caller gets to choose.
pub const CIRCLE_SEED: &[u8] = b"circle";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault-authority";
pub const ROUND_SEED: &[u8] = b"round";
pub const SLOT_SEED: &[u8] = b"slot";

#[program]
pub mod quittance {
    use super::*;

    /// Open a circle.
    ///
    /// The organizer names the members and the order in which they collect.
    /// Both are fixed here: a rotation that could be reordered later is a
    /// rotation the organizer can game, and the whole reason this product
    /// exists is that these groups run on trust that keeps breaking.
    pub fn create_circle(
        ctx: Context<CreateCircle>,
        contribution_amount: u64,
        cadence_seconds: i64,
        members: Vec<Pubkey>,
        rotation_order: Vec<u8>,
    ) -> Result<()> {
        require!(members.len() >= 2, QuittanceError::TooFewMembers);
        require!(members.len() <= MAX_MEMBERS, QuittanceError::TooManyMembers);
        require!(contribution_amount > 0, QuittanceError::ZeroContribution);
        require!(cadence_seconds > 0, QuittanceError::InvalidCadence);
        require!(
            is_permutation(&rotation_order, members.len()),
            QuittanceError::InvalidRotationOrder
        );

        let circle = &mut ctx.accounts.circle;
        circle.organizer = ctx.accounts.organizer.key();
        circle.mint = ctx.accounts.mint.key();
        circle.vault = ctx.accounts.vault.key();
        circle.contribution_amount = contribution_amount;
        circle.cadence_seconds = cadence_seconds;
        circle.members = members;
        circle.rotation_order = rotation_order;
        circle.joined_count = 0;
        circle.rounds_opened = 0;
        circle.rounds_disbursed = 0;
        circle.created_at = Clock::get()?.unix_timestamp;
        circle.bump = ctx.bumps.circle;

        Ok(())
    }

    /// Accept membership.
    ///
    /// A member signs for themselves. The organizer listing someone is an
    /// invitation, not an obligation, and nobody is enrolled in a financial
    /// commitment by somebody else's signature.
    pub fn join_circle(ctx: Context<JoinCircle>) -> Result<()> {
        let circle = &mut ctx.accounts.circle;
        let member = ctx.accounts.member.key();

        let index = circle
            .member_index(&member)
            .ok_or(QuittanceError::NotAMember)?;
        require!(
            !ctx.accounts.membership.accepted,
            QuittanceError::AlreadyJoined
        );

        let membership = &mut ctx.accounts.membership;
        membership.circle = circle.key();
        membership.member = member;
        membership.member_index = index;
        membership.accepted = true;
        membership.joined_at = Clock::get()?.unix_timestamp;
        membership.bump = ctx.bumps.membership;

        circle.joined_count = circle
            .joined_count
            .checked_add(1)
            .ok_or(QuittanceError::TooManyMembers)?;

        Ok(())
    }

    /// Open a round.
    ///
    /// `slots_expected` is frozen here from the joined member count, so a
    /// member joining mid-round cannot change the bar the round has to clear
    /// before it pays out. The recipient is frozen here for the same reason.
    pub fn open_round(ctx: Context<OpenRound>, round_index: u32) -> Result<()> {
        let circle = &ctx.accounts.circle;
        require!(
            ctx.accounts.organizer.key() == circle.organizer,
            QuittanceError::NotOrganizer
        );
        require!(
            circle.joined_count as usize == circle.members.len(),
            QuittanceError::CircleNotFull
        );
        require!(
            round_index == circle.rounds_opened,
            QuittanceError::RoundOutOfOrder
        );

        let recipient = circle
            .recipient_for_round(round_index)
            .ok_or(QuittanceError::InvalidRotationOrder)?;

        let round = &mut ctx.accounts.round;
        round.circle = circle.key();
        round.index = round_index;
        round.recipient = recipient;
        round.slots_expected = circle.joined_count;
        round.slots_terminal = 0;
        round.total_credited = 0;
        round.opened_at = Clock::get()?.unix_timestamp;
        round.closed = false;
        round.disbursed = false;
        round.disbursed_at = 0;
        round.bump = ctx.bumps.round;

        let circle = &mut ctx.accounts.circle;
        circle.rounds_opened = round_index
            .checked_add(1)
            .ok_or(QuittanceError::RoundOutOfOrder)?;

        Ok(())
    }

    /// Record the terminal state of one contribution slot.
    ///
    /// Called once per slot, with the verdict the engine reached. The slot
    /// account is a PDA over the circle, round, and member, so one slot can
    /// be recorded exactly once and the address is not the caller's to choose.
    ///
    /// Three things are enforced here, and the first is the interesting one:
    ///
    /// 1. **A settlement must be backed by money already in the vault.** The
    ///    vault's observed token balance must cover everything this round has
    ///    credited plus this contribution. This is I2 enforced on chain: a
    ///    client asserting a settlement that did not happen would first have
    ///    to fund the vault, which is indistinguishable from paying.
    /// 2. **A machine verdict is recorded by the member it belongs to.** A
    ///    member can speak to their own contribution and nobody else's.
    /// 3. **A human override is recorded by the organizer, and is marked as
    ///    an override.** It never masquerades as a chain fact; the verifier
    ///    reports machine verdicts and overrides on separate lines.
    pub fn record_contribution(
        ctx: Context<RecordContribution>,
        round_index: u32,
        slot_state: SlotState,
        reason: Option<AmbiguityReason>,
        message_hash: [u8; 32],
        consuming_signature: Option<[u8; 64]>,
        attribution: Attribution,
    ) -> Result<()> {
        let circle = &ctx.accounts.circle;
        let round = &ctx.accounts.round;

        require!(!round.closed, QuittanceError::RoundClosed);
        require!(round.index == round_index, QuittanceError::RoundOutOfOrder);

        // A PDA-derived slot that already carries a recorded state is a
        // re-record attempt. States do not change once recorded; a slot that
        // needs revisiting is an ambiguity resolved through `resolve_slot`.
        require!(
            !ctx.accounts.slot.recorded,
            QuittanceError::SlotAlreadyRecorded
        );

        let member = ctx.accounts.member.key();
        require!(
            circle.member_index(&member).is_some(),
            QuittanceError::NotAMember
        );

        match slot_state {
            SlotState::Ambiguous => {
                require!(reason.is_some(), QuittanceError::MissingAmbiguityReason);
            }
            _ => {
                require!(reason.is_none(), QuittanceError::UnexpectedAmbiguityReason);
            }
        }

        match attribution {
            Attribution::Machine => {
                // The signer must be the member whose contribution this is.
                require!(
                    ctx.accounts.authority.key() == member,
                    QuittanceError::VerdictNotByMember
                );
            }
            Attribution::HumanOverride => {
                require!(
                    ctx.accounts.authority.key() == circle.organizer,
                    QuittanceError::OverrideNotByOrganizer
                );
            }
        }

        // I2 on chain. Credit only against money that is already here.
        if slot_state == SlotState::Settled {
            let required = round
                .total_credited
                .checked_add(circle.contribution_amount)
                .ok_or(QuittanceError::VaultShortOfCredit)?;
            require!(
                ctx.accounts.vault.amount >= required,
                QuittanceError::VaultShortOfCredit
            );
        }

        let slot = &mut ctx.accounts.slot;
        slot.circle = circle.key();
        slot.round_index = round_index;
        slot.member = member;
        slot.nonce_account = ctx.accounts.nonce_account.key();
        slot.state = slot_state;
        slot.reason = reason;
        slot.message_hash = message_hash;
        slot.consuming_signature = consuming_signature;
        slot.attribution = attribution;
        slot.decided_by = ctx.accounts.authority.key();
        slot.recorded_at = Clock::get()?.unix_timestamp;
        slot.recorded = true;
        slot.bump = ctx.bumps.slot;

        let round = &mut ctx.accounts.round;
        if slot_state == SlotState::Settled {
            round.total_credited = round
                .total_credited
                .checked_add(circle.contribution_amount)
                .ok_or(QuittanceError::VaultShortOfCredit)?;
        }
        // An escalated slot counts as terminal for the machine but not for a
        // payout: `close_round` refuses while any slot is still `Ambiguous`,
        // so the organizer has to resolve it rather than wait it out.
        round.slots_terminal = round
            .slots_terminal
            .checked_add(1)
            .ok_or(QuittanceError::RoundHasOpenContributions)?;

        Ok(())
    }

    /// Resolve an escalated slot.
    ///
    /// The only way a slot leaves `Ambiguous`, and it is always the
    /// organizer's recorded, attributed decision. Two outcomes only, matching
    /// the two safe actions the resolve screen offers:
    ///
    /// * `Settled` — accept as paid. Still subject to the vault check, so the
    ///   organizer cannot accept a payment the vault never received.
    /// * `NotSent` — mark unpaid and reissue. Off chain, the old nonce is
    ///   advanced first so the superseded transaction can never land.
    ///
    /// There is no third option, here or in the interface.
    pub fn resolve_slot(
        ctx: Context<ResolveSlot>,
        round_index: u32,
        resolved_to: SlotState,
    ) -> Result<()> {
        let circle = &ctx.accounts.circle;
        require!(
            ctx.accounts.organizer.key() == circle.organizer,
            QuittanceError::OverrideNotByOrganizer
        );
        require!(
            ctx.accounts.round.index == round_index,
            QuittanceError::RoundOutOfOrder
        );
        require!(!ctx.accounts.round.closed, QuittanceError::RoundClosed);
        require!(
            ctx.accounts.slot.state == SlotState::Ambiguous,
            QuittanceError::SlotAlreadyRecorded
        );
        require!(
            resolved_to == SlotState::Settled || resolved_to == SlotState::NotSent,
            QuittanceError::UnexpectedAmbiguityReason
        );

        if resolved_to == SlotState::Settled {
            let required = ctx
                .accounts
                .round
                .total_credited
                .checked_add(circle.contribution_amount)
                .ok_or(QuittanceError::VaultShortOfCredit)?;
            require!(
                ctx.accounts.vault.amount >= required,
                QuittanceError::VaultShortOfCredit
            );
        }

        let slot = &mut ctx.accounts.slot;
        slot.state = resolved_to;
        // The reason it escalated is kept, not cleared. Erasing it would hide
        // that a human had to intervene, which is exactly what the evidence
        // log exists to preserve.
        slot.attribution = Attribution::HumanOverride;
        slot.decided_by = ctx.accounts.organizer.key();
        slot.recorded_at = Clock::get()?.unix_timestamp;

        if resolved_to == SlotState::Settled {
            let round = &mut ctx.accounts.round;
            round.total_credited = round
                .total_credited
                .checked_add(circle.contribution_amount)
                .ok_or(QuittanceError::VaultShortOfCredit)?;
        }

        Ok(())
    }

    /// Close a round for collection.
    ///
    /// **I3 is enforced here and again in `disburse`.** Twice, on purpose: a
    /// single check is a single place to get wrong, and this is one of the two
    /// invariants that must never fail.
    pub fn close_round(ctx: Context<CloseRound>, round_index: u32) -> Result<()> {
        let circle = &ctx.accounts.circle;
        require!(
            ctx.accounts.organizer.key() == circle.organizer,
            QuittanceError::NotOrganizer
        );
        let round = &ctx.accounts.round;
        require!(round.index == round_index, QuittanceError::RoundOutOfOrder);
        require!(!round.closed, QuittanceError::RoundClosed);
        require!(
            round.all_slots_terminal(),
            QuittanceError::RoundHasOpenContributions
        );

        let round = &mut ctx.accounts.round;
        round.closed = true;
        Ok(())
    }

    /// Pay the pot to the round's rotation recipient.
    ///
    /// **I4 lives here.** The disbursed flag is read and written inside this
    /// one instruction, before the transfer CPI. Two concurrent `disburse`
    /// calls both write `round`, so the runtime serializes them: the first
    /// sets the flag and moves the money, and the second loads a round whose
    /// flag is already set and fails with `AlreadyDisbursed`. There is no
    /// interleaving to exploit, because the check and the set are not two
    /// transactions.
    ///
    /// **I3 is re-checked here** rather than trusted from `close_round`.
    pub fn disburse(ctx: Context<Disburse>, round_index: u32) -> Result<()> {
        let circle = &ctx.accounts.circle;
        require!(
            ctx.accounts.organizer.key() == circle.organizer,
            QuittanceError::NotOrganizer
        );

        {
            let round = &ctx.accounts.round;
            require!(round.index == round_index, QuittanceError::RoundOutOfOrder);
            require!(round.closed, QuittanceError::RoundNotClosed);
            // I4.
            require!(!round.disbursed, QuittanceError::AlreadyDisbursed);
            // I3, a second time.
            require!(
                round.all_slots_terminal(),
                QuittanceError::RoundHasOpenContributions
            );
            require!(
                ctx.accounts.recipient.key() == round.recipient,
                QuittanceError::WrongRecipient
            );
            require!(
                ctx.accounts.vault.amount >= round.total_credited,
                QuittanceError::VaultBelowCredited
            );
        }

        let amount = ctx.accounts.round.total_credited;

        // Set the flag before the CPI, not after. If the transfer fails the
        // whole transaction unwinds and the flag unwinds with it, so setting
        // it first costs nothing and removes any window in which a second
        // call could observe an unflagged, already-paying round.
        {
            let round = &mut ctx.accounts.round;
            round.disbursed = true;
            round.disbursed_at = Clock::get()?.unix_timestamp;
        }

        let circle_key = ctx.accounts.circle.key();
        let authority_bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, circle_key.as_ref(), &[authority_bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        let circle = &mut ctx.accounts.circle;
        circle.rounds_disbursed = circle
            .rounds_disbursed
            .checked_add(1)
            .ok_or(QuittanceError::AlreadyDisbursed)?;

        Ok(())
    }
}

/// Whether `order` lists every index in `0..count` exactly once.
///
/// A rotation that repeated a member would pay one person twice over a cycle
/// and another never, which is the single most damaging thing this program
/// could get wrong, so it is validated rather than assumed.
fn is_permutation(order: &[u8], count: usize) -> bool {
    if order.len() != count || count > MAX_MEMBERS {
        return false;
    }
    let mut seen = [false; MAX_MEMBERS];
    for &index in order {
        let index = index as usize;
        if index >= count || seen[index] {
            return false;
        }
        seen[index] = true;
    }
    true
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[account]
pub struct Membership {
    pub circle: Pubkey,
    pub member: Pubkey,
    pub member_index: u8,
    pub accepted: bool,
    pub joined_at: i64,
    pub bump: u8,
}

impl Membership {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 8 + 1;
}

#[derive(Accounts)]
#[instruction(contribution_amount: u64, cadence_seconds: i64, members: Vec<Pubkey>)]
pub struct CreateCircle<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,

    #[account(
        init,
        payer = organizer,
        space = Circle::space(members.len()),
        seeds = [CIRCLE_SEED, organizer.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub circle: Account<'info, Circle>,

    pub mint: Account<'info, Mint>,

    /// The vault authority PDA. Nobody holds its key, including the organizer.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, circle.key().as_ref()],
        bump,
    )]
    /// CHECK: a PDA used only as a signing authority; it holds no data.
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = organizer,
        token::mint = mint,
        token::authority = vault_authority,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct JoinCircle<'info> {
    #[account(mut)]
    pub member: Signer<'info>,

    #[account(mut)]
    pub circle: Account<'info, Circle>,

    #[account(
        init_if_needed,
        payer = member,
        space = Membership::SPACE,
        seeds = [b"membership", circle.key().as_ref(), member.key().as_ref()],
        bump,
    )]
    pub membership: Account<'info, Membership>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_index: u32)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,

    #[account(mut, has_one = organizer)]
    pub circle: Account<'info, Circle>,

    #[account(
        init,
        payer = organizer,
        space = Round::SPACE,
        seeds = [ROUND_SEED, circle.key().as_ref(), &round_index.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_index: u32)]
pub struct RecordContribution<'info> {
    /// The member for a machine verdict, the organizer for an override. The
    /// instruction checks which, against `attribution`.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The member this contribution belongs to. Not a signer, because an
    /// organizer recording an override signs instead.
    /// CHECK: validated against the circle's member list in the instruction.
    pub member: UncheckedAccount<'info>,

    pub circle: Account<'info, Circle>,

    #[account(
        mut,
        seeds = [ROUND_SEED, circle.key().as_ref(), &round_index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        init_if_needed,
        payer = authority,
        space = ContributionSlot::SPACE,
        seeds = [
            SLOT_SEED,
            circle.key().as_ref(),
            &round_index.to_le_bytes(),
            member.key().as_ref(),
        ],
        bump,
    )]
    pub slot: Account<'info, ContributionSlot>,

    /// The durable nonce account this contribution was anchored to, recorded
    /// so that anyone can re-derive the verdict from chain state alone.
    /// CHECK: stored as a reference for independent verification; this
    /// program does not read its contents.
    pub nonce_account: UncheckedAccount<'info>,

    #[account(
        address = circle.vault @ QuittanceError::InvalidVault,
        constraint = vault.mint == circle.mint @ QuittanceError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_index: u32)]
pub struct ResolveSlot<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,

    #[account(has_one = organizer)]
    pub circle: Account<'info, Circle>,

    #[account(
        mut,
        seeds = [ROUND_SEED, circle.key().as_ref(), &round_index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [
            SLOT_SEED,
            circle.key().as_ref(),
            &round_index.to_le_bytes(),
            slot.member.as_ref(),
        ],
        bump = slot.bump,
    )]
    pub slot: Account<'info, ContributionSlot>,

    #[account(
        address = circle.vault @ QuittanceError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(round_index: u32)]
pub struct CloseRound<'info> {
    pub organizer: Signer<'info>,

    #[account(has_one = organizer)]
    pub circle: Account<'info, Circle>,

    #[account(
        mut,
        seeds = [ROUND_SEED, circle.key().as_ref(), &round_index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
#[instruction(round_index: u32)]
pub struct Disburse<'info> {
    pub organizer: Signer<'info>,

    #[account(mut, has_one = organizer)]
    pub circle: Account<'info, Circle>,

    #[account(
        mut,
        seeds = [ROUND_SEED, circle.key().as_ref(), &round_index.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// The member whose turn this round is. Checked against `round.recipient`.
    /// CHECK: compared to the recipient frozen when the round opened.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key()
            @ QuittanceError::InvalidRecipientAccount,
        constraint = recipient_token_account.mint == circle.mint
            @ QuittanceError::InvalidRecipientAccount,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, circle.key().as_ref()],
        bump,
    )]
    /// CHECK: a PDA used only as a signing authority; it holds no data.
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = circle.vault @ QuittanceError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
