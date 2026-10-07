//! Account state.
//!
//! The program holds the circle, the rotation, and the accounting. It does
//! not hold anyone's money for longer than one round, and the organizer is
//! never a custodian: the vault is a program-owned token account and the
//! only instruction that can move funds out of it is `disburse`, which pays
//! the round's rotation recipient and nobody else.

use anchor_lang::prelude::*;

/// The maximum members a single circle can hold.
///
/// Twelve is the common size for a weekly rotation and twenty-four covers a
/// fortnightly year. The cap exists because the member list is stored inline
/// and an account's size must be known at creation; a larger circle is a
/// second circle, which is also how these groups work in practice.
pub const MAX_MEMBERS: usize = 24;

/// The terminal state of one contribution slot, as recorded on chain.
///
/// Four variants, not two. The absent fifth and sixth — `Drafted` and
/// `InFlight` — are deliberately unrepresentable here: they are states the
/// phone holds while it does not yet know the answer, and the chain is never
/// asked to store the phone's uncertainty.
///
/// `Rejected` exists because a durable nonce advances even when the transfer
/// it carried failed. The runtime rolls the accounts back and then stores the
/// advanced nonce anyway, specifically to stop replay of a failed nonce
/// transaction. So "the nonce moved" means processed, not paid, and a program
/// that recorded only paid/unpaid would credit failed transfers.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SlotState {
    /// A transaction matching the recorded intent confirmed and the money moved.
    Settled,
    /// Processed on chain, the instruction failed, nothing moved.
    Rejected,
    /// Definitively never processed. The nonce still holds the built value.
    NotSent,
    /// The machine refused to decide. Carries the reason it refused.
    Ambiguous,
}

/// Why a slot escalated. Mirrors the engine's named reasons exactly.
///
/// There is no `Unknown` variant. An escalation without a reason is not an
/// escalation, it is a shrug, and the resolve screen has nothing to show the
/// organizer.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AmbiguityReason {
    NonceAccountGone,
    BeyondRetention,
    ForeignConsumer,
    BalanceDisagrees,
    TransactionUnavailable,
}

/// How a slot's recorded state was arrived at.
///
/// Stored so that a human decision can never be mistaken for a chain fact.
/// The verifier reports the two on separate lines for exactly this reason.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Attribution {
    /// The verdict machine reached this state from chain state alone.
    Machine,
    /// A human resolved an ambiguity. `decided_by` names them.
    HumanOverride,
}

#[account]
pub struct Circle {
    /// Opens the circle, stakes the nonce lease, and triggers each payout.
    /// Holds no funds and cannot redirect a payout.
    pub organizer: Pubkey,
    /// The SPL mint every contribution is denominated in.
    pub mint: Pubkey,
    /// The program-owned token account that holds the pot between rounds.
    pub vault: Pubkey,
    /// Raw contribution per member per round, in the mint's smallest unit.
    pub contribution_amount: u64,
    /// Seconds between rounds. Weekly is 604 800.
    pub cadence_seconds: i64,
    /// Members, in join order.
    pub members: Vec<Pubkey>,
    /// Indices into `members`, giving the order in which each collects.
    /// A permutation of `0..member_count`, validated at creation.
    pub rotation_order: Vec<u8>,
    /// How many members have accepted membership so far.
    pub joined_count: u8,
    /// The highest round index that has been opened.
    pub rounds_opened: u32,
    /// Rounds that have paid out. Used to walk the rotation.
    pub rounds_disbursed: u32,
    pub created_at: i64,
    pub bump: u8,
}

impl Circle {
    pub fn space(member_count: usize) -> usize {
        8                           // discriminator
            + 32                    // organizer
            + 32                    // mint
            + 32                    // vault
            + 8                     // contribution_amount
            + 8                     // cadence_seconds
            + 4 + member_count * 32 // members
            + 4 + member_count      // rotation_order
            + 1                     // joined_count
            + 4                     // rounds_opened
            + 4                     // rounds_disbursed
            + 8                     // created_at
            + 1 // bump
    }

    pub fn member_index(&self, member: &Pubkey) -> Option<u8> {
        self.members
            .iter()
            .position(|candidate| candidate == member)
            .map(|index| index as u8)
    }

    /// The member who collects the pot in `round_index`.
    pub fn recipient_for_round(&self, round_index: u32) -> Option<Pubkey> {
        let position = (round_index as usize) % self.rotation_order.len();
        let member_index = *self.rotation_order.get(position)? as usize;
        self.members.get(member_index).copied()
    }
}

#[account]
pub struct Round {
    pub circle: Pubkey,
    pub index: u32,
    /// The member who collects this round, fixed when the round opens so that
    /// a later change to the circle cannot redirect a pot in flight.
    pub recipient: Pubkey,
    /// How many contribution slots must reach a terminal state. Set at open
    /// from the joined member count, so a member joining mid-round cannot
    /// change the bar a round has to clear.
    pub slots_expected: u8,
    /// How many have. I3 is `slots_terminal == slots_expected`.
    pub slots_terminal: u8,
    /// The sum the program has credited as settled. Only ever increased
    /// against an observed vault balance, which is what makes a phantom
    /// credit impossible on chain rather than merely unlikely.
    pub total_credited: u64,
    pub opened_at: i64,
    pub closed: bool,
    /// I4 lives here. Checked and set in the same instruction as the transfer.
    pub disbursed: bool,
    pub disbursed_at: i64,
    pub bump: u8,
}

impl Round {
    pub const SPACE: usize = 8 + 32 + 4 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 8 + 1;

    pub fn all_slots_terminal(&self) -> bool {
        self.slots_terminal == self.slots_expected
    }
}

#[account]
pub struct ContributionSlot {
    pub circle: Pubkey,
    pub round_index: u32,
    pub member: Pubkey,
    /// The leased durable nonce account this contribution was anchored to.
    ///
    /// Stored on chain so that anyone — with no access to the phone, the app,
    /// or the wallet — can read this one pubkey, call
    /// `getSignaturesForAddress` on it, and recompute the whole verdict
    /// themselves. This single field is what makes I6 checkable by a stranger.
    pub nonce_account: Pubkey,
    pub state: SlotState,
    /// Present exactly when `state == Ambiguous`.
    pub reason: Option<AmbiguityReason>,
    /// sha256 of the compiled transaction message the phone recorded before
    /// the wallet was opened. The identity the verdict machine matches against.
    pub message_hash: [u8; 32],
    /// The transaction that consumed the nonce, when one was identified.
    pub consuming_signature: Option<[u8; 64]>,
    pub attribution: Attribution,
    /// Who recorded this state. The member for a machine verdict, the
    /// organizer for a human override.
    pub decided_by: Pubkey,
    pub recorded_at: i64,
    /// Whether a state has ever been written to this slot.
    ///
    /// The slot account is a PDA over circle, round, and member, and it is
    /// created with `init_if_needed` so that recording is a single
    /// instruction. That makes this flag the thing that distinguishes "not
    /// yet recorded" from "recorded", because a freshly initialized account
    /// is all zeroes and `SlotState::Settled` is discriminant zero. Without
    /// it, an uninitialized slot would read as settled.
    pub recorded: bool,
    pub bump: u8,
}

impl ContributionSlot {
    pub const SPACE: usize = 8      // discriminator
        + 32                        // circle
        + 4                         // round_index
        + 32                        // member
        + 32                        // nonce_account
        + 1 + 1                     // state (enum, widest variant)
        + 1 + 1                     // reason Option<enum>
        + 32                        // message_hash
        + 1 + 64                    // consuming_signature Option
        + 1 + 1                     // attribution
        + 32                        // decided_by
        + 8                         // recorded_at
        + 1                         // recorded
        + 1; // bump
}
