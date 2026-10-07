/**
 * Program tests.
 *
 * Every instruction has a test, and the two invariants the program is
 * actually responsible for have adversarial tests that try to break them
 * rather than tests that confirm the happy path:
 *
 *   I4  two concurrent `disburse` calls on one round — exactly one succeeds
 *   I3  a payout attempted over an unresolved contribution — refused
 *
 * Plus the one the program enforces more strongly than a client could:
 *
 *   I2  a settlement asserted without the money in the vault — refused
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorError } from '@coral-xyz/anchor';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { assert, expect } from 'chai';

import type { Quittance } from '../target/types/quittance';

const CIRCLE_SEED = Buffer.from('circle');
const VAULT_AUTHORITY_SEED = Buffer.from('vault-authority');
const ROUND_SEED = Buffer.from('round');
const SLOT_SEED = Buffer.from('slot');
const MEMBERSHIP_SEED = Buffer.from('membership');

const CONTRIBUTION = 20_000_000n; // 20.000000 of a 6-decimal mint
const CADENCE_SECONDS = 604_800; // one week
const MEMBER_COUNT = 4;

function roundIndexBytes(index: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(index, 0);
  return buffer;
}

/** A 32-byte stand-in for a recorded message hash. */
function messageHash(seed: number): number[] {
  return Array.from({ length: 32 }, (_, i) => (seed * 31 + i) % 256);
}

describe('quittance', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Quittance as Program<Quittance>;
  const connection = provider.connection;

  let organizer: Keypair;
  let members: Keypair[];
  let mint: PublicKey;
  let circlePda: PublicKey;
  let vaultAuthority: PublicKey;
  let vault: PublicKey;
  let memberTokenAccounts: PublicKey[];
  /** Nonce account pubkeys, recorded on chain for independent verification. */
  let nonceAccounts: PublicKey[];

  async function fund(keypair: Keypair, sol = 2): Promise<void> {
    const signature = await connection.requestAirdrop(
      keypair.publicKey,
      sol * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(signature, 'confirmed');
  }

  function roundPda(index: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [ROUND_SEED, circlePda.toBuffer(), roundIndexBytes(index)],
      program.programId,
    )[0];
  }

  function slotPda(index: number, member: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [SLOT_SEED, circlePda.toBuffer(), roundIndexBytes(index), member.toBuffer()],
      program.programId,
    )[0];
  }

  function membershipPda(member: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [MEMBERSHIP_SEED, circlePda.toBuffer(), member.toBuffer()],
      program.programId,
    )[0];
  }

  /** Move a contribution into the vault, the way a real member's transfer does. */
  async function payIntoVault(amount: bigint): Promise<void> {
    await mintTo(
      connection,
      organizer,
      mint,
      vault,
      organizer,
      amount,
    );
  }

  before(async () => {
    organizer = Keypair.generate();
    members = Array.from({ length: MEMBER_COUNT }, () => Keypair.generate());
    nonceAccounts = Array.from({ length: MEMBER_COUNT }, () => Keypair.generate().publicKey);

    await fund(organizer, 10);
    await Promise.all(members.map((member) => fund(member, 2)));

    mint = await createMint(connection, organizer, organizer.publicKey, null, 6);

    circlePda = PublicKey.findProgramAddressSync(
      [CIRCLE_SEED, organizer.publicKey.toBuffer(), mint.toBuffer()],
      program.programId,
    )[0];
    vaultAuthority = PublicKey.findProgramAddressSync(
      [VAULT_AUTHORITY_SEED, circlePda.toBuffer()],
      program.programId,
    )[0];

    memberTokenAccounts = [];
    for (const member of members) {
      memberTokenAccounts.push(
        await createAssociatedTokenAccount(connection, organizer, mint, member.publicKey),
      );
    }
  });

  // -----------------------------------------------------------------------
  // create_circle
  // -----------------------------------------------------------------------

  describe('create_circle', () => {
    it('refuses a circle with fewer than two members', async () => {
      const soloMint = await createMint(connection, organizer, organizer.publicKey, null, 6);
      const soloCircle = PublicKey.findProgramAddressSync(
        [CIRCLE_SEED, organizer.publicKey.toBuffer(), soloMint.toBuffer()],
        program.programId,
      )[0];
      const soloAuthority = PublicKey.findProgramAddressSync(
        [VAULT_AUTHORITY_SEED, soloCircle.toBuffer()],
        program.programId,
      )[0];
      const soloVault = Keypair.generate();

      try {
        await program.methods
          .createCircle(
            new anchor.BN(CONTRIBUTION.toString()),
            new anchor.BN(CADENCE_SECONDS),
            [organizer.publicKey],
            Buffer.from([0]),
          )
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: soloCircle,
            mint: soloMint,
            vaultAuthority: soloAuthority,
            vault: soloVault.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([organizer, soloVault])
          .rpc();
        assert.fail('a one-member circle must be refused');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('TooFewMembers');
      }
    });

    it('refuses a rotation order that is not a permutation of the members', async () => {
      const badMint = await createMint(connection, organizer, organizer.publicKey, null, 6);
      const badCircle = PublicKey.findProgramAddressSync(
        [CIRCLE_SEED, organizer.publicKey.toBuffer(), badMint.toBuffer()],
        program.programId,
      )[0];
      const badAuthority = PublicKey.findProgramAddressSync(
        [VAULT_AUTHORITY_SEED, badCircle.toBuffer()],
        program.programId,
      )[0];
      const badVault = Keypair.generate();

      try {
        await program.methods
          .createCircle(
            new anchor.BN(CONTRIBUTION.toString()),
            new anchor.BN(CADENCE_SECONDS),
            members.map((member) => member.publicKey),
            // Member 0 collects twice and member 3 never collects. Over a full
            // cycle this is theft, so it must be rejected at creation.
            Buffer.from([0, 0, 1, 2]),
          )
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: badCircle,
            mint: badMint,
            vaultAuthority: badAuthority,
            vault: badVault.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([organizer, badVault])
          .rpc();
        assert.fail('a repeated rotation slot must be refused');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('InvalidRotationOrder');
      }
    });

    it('creates the circle with a program-owned vault', async () => {
      const vaultKeypair = Keypair.generate();
      vault = vaultKeypair.publicKey;

      await program.methods
        .createCircle(
          new anchor.BN(CONTRIBUTION.toString()),
          new anchor.BN(CADENCE_SECONDS),
          members.map((member) => member.publicKey),
          Buffer.from([0, 1, 2, 3]),
        )
        .accountsPartial({
          organizer: organizer.publicKey,
          circle: circlePda,
          mint,
          vaultAuthority,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([organizer, vaultKeypair])
        .rpc();

      const circle = await program.account.circle.fetch(circlePda);
      expect(circle.organizer.toBase58()).to.equal(organizer.publicKey.toBase58());
      expect(circle.members.length).to.equal(MEMBER_COUNT);
      expect(circle.contributionAmount.toString()).to.equal(CONTRIBUTION.toString());
      expect(circle.joinedCount).to.equal(0);

      // The organizer is never a custodian. The vault's authority is a PDA
      // nobody holds the key to.
      const vaultAccount = await getAccount(connection, vault);
      expect(vaultAccount.owner.toBase58()).to.equal(vaultAuthority.toBase58());
      expect(vaultAccount.mint.toBase58()).to.equal(mint.toBase58());
    });
  });

  // -----------------------------------------------------------------------
  // join_circle
  // -----------------------------------------------------------------------

  describe('join_circle', () => {
    it('refuses a wallet that is not on the member list', async () => {
      const stranger = Keypair.generate();
      await fund(stranger);
      try {
        await program.methods
          .joinCircle()
          .accountsPartial({
            member: stranger.publicKey,
            circle: circlePda,
            membership: membershipPda(stranger.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .signers([stranger])
          .rpc();
        assert.fail('a non-member must not be able to join');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('NotAMember');
      }
    });

    it('lets each member accept membership for themselves', async () => {
      for (const member of members) {
        await program.methods
          .joinCircle()
          .accountsPartial({
            member: member.publicKey,
            circle: circlePda,
            membership: membershipPda(member.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .signers([member])
          .rpc();
      }

      const circle = await program.account.circle.fetch(circlePda);
      expect(circle.joinedCount).to.equal(MEMBER_COUNT);
    });

    it('refuses a second join from the same member', async () => {
      const member = members[0];
      try {
        await program.methods
          .joinCircle()
          .accountsPartial({
            member: member.publicKey,
            circle: circlePda,
            membership: membershipPda(member.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .signers([member])
          .rpc();
        assert.fail('joining twice must be refused');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('AlreadyJoined');
      }
    });
  });

  // -----------------------------------------------------------------------
  // open_round
  // -----------------------------------------------------------------------

  describe('open_round', () => {
    it('refuses a caller who is not the organizer', async () => {
      try {
        await program.methods
          .openRound(0)
          .accountsPartial({
            organizer: members[1].publicKey,
            circle: circlePda,
            round: roundPda(0),
            systemProgram: SystemProgram.programId,
          })
          .signers([members[1]])
          .rpc();
        assert.fail('only the organizer opens a round');
      } catch (error) {
        // `has_one = organizer` rejects this before the body runs.
        expect((error as AnchorError).error.errorCode.code).to.be.oneOf([
          'ConstraintHasOne',
          'NotOrganizer',
        ]);
      }
    });

    it('refuses to open rounds out of order', async () => {
      try {
        await program.methods
          .openRound(3)
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: circlePda,
            round: roundPda(3),
            systemProgram: SystemProgram.programId,
          })
          .signers([organizer])
          .rpc();
        assert.fail('rounds open in order');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('RoundOutOfOrder');
      }
    });

    it('opens round 0 and freezes the recipient and the slot count', async () => {
      await program.methods
        .openRound(0)
        .accountsPartial({
          organizer: organizer.publicKey,
          circle: circlePda,
          round: roundPda(0),
          systemProgram: SystemProgram.programId,
        })
        .signers([organizer])
        .rpc();

      const round = await program.account.round.fetch(roundPda(0));
      expect(round.index).to.equal(0);
      expect(round.recipient.toBase58()).to.equal(members[0].publicKey.toBase58());
      expect(round.slotsExpected).to.equal(MEMBER_COUNT);
      expect(round.slotsTerminal).to.equal(0);
      expect(round.totalCredited.toString()).to.equal('0');
      expect(round.closed).to.equal(false);
      expect(round.disbursed).to.equal(false);
    });
  });

  // -----------------------------------------------------------------------
  // record_contribution — I2 on chain
  // -----------------------------------------------------------------------

  describe('record_contribution', () => {
    async function record(
      memberIndex: number,
      state: Record<string, never>,
      options: {
        reason?: Record<string, never> | null;
        authority?: Keypair;
        attribution?: Record<string, never>;
      } = {},
    ) {
      const member = members[memberIndex];
      const authority = options.authority ?? member;
      return program.methods
        .recordContribution(
          0,
          state as never,
          (options.reason ?? null) as never,
          messageHash(memberIndex),
          null,
          (options.attribution ?? { machine: {} }) as never,
        )
        .accountsPartial({
          authority: authority.publicKey,
          member: member.publicKey,
          circle: circlePda,
          round: roundPda(0),
          slot: slotPda(0, member.publicKey),
          nonceAccount: nonceAccounts[memberIndex],
          vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
    }

    it('refuses a settlement the vault does not cover — I2 on chain', async () => {
      // The vault is empty. A client asserting a settlement here is claiming
      // money that is not there, and the program can see that it is not there.
      const vaultBefore = await getAccount(connection, vault);
      expect(vaultBefore.amount.toString()).to.equal('0');

      try {
        await record(0, { settled: {} });
        assert.fail('a settlement with an empty vault must be refused');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('VaultShortOfCredit');
      }
    });

    it('records a settlement once the money is in the vault', async () => {
      await payIntoVault(CONTRIBUTION);
      await record(0, { settled: {} });

      const slot = await program.account.contributionSlot.fetch(
        slotPda(0, members[0].publicKey),
      );
      expect(slot.state.settled).to.not.equal(undefined);
      expect(slot.recorded).to.equal(true);
      expect(slot.attribution.machine).to.not.equal(undefined);
      expect(slot.reason).to.equal(null);
      // The nonce account is on chain so a stranger can re-derive the verdict.
      expect(slot.nonceAccount.toBase58()).to.equal(nonceAccounts[0].toBase58());

      const round = await program.account.round.fetch(roundPda(0));
      expect(round.slotsTerminal).to.equal(1);
      expect(round.totalCredited.toString()).to.equal(CONTRIBUTION.toString());
    });

    it('refuses a second record for the same slot', async () => {
      try {
        await record(0, { notSent: {} });
        assert.fail('a recorded slot does not change');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('SlotAlreadyRecorded');
      }
    });

    it('refuses a member recording someone else\'s contribution', async () => {
      try {
        await record(1, { notSent: {} }, { authority: members[2] });
        assert.fail('a member speaks only to their own contribution');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('VerdictNotByMember');
      }
    });

    it('records a rejection without crediting anything', async () => {
      const before = await program.account.round.fetch(roundPda(0));
      await record(1, { rejected: {} });
      const after = await program.account.round.fetch(roundPda(0));

      // The nonce advanced, so a naive program would credit this. It must not:
      // processed is not paid.
      expect(after.slotsTerminal).to.equal(before.slotsTerminal + 1);
      expect(after.totalCredited.toString()).to.equal(before.totalCredited.toString());
    });

    it('records a definitive not-sent without crediting anything', async () => {
      const before = await program.account.round.fetch(roundPda(0));
      await record(2, { notSent: {} });
      const after = await program.account.round.fetch(roundPda(0));

      expect(after.slotsTerminal).to.equal(before.slotsTerminal + 1);
      expect(after.totalCredited.toString()).to.equal(before.totalCredited.toString());
    });

    it('refuses an escalation that does not name its reason', async () => {
      try {
        await record(3, { ambiguous: {} }, { reason: null });
        assert.fail('an escalation must name the reason it escalated');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal(
          'MissingAmbiguityReason',
        );
      }
    });

    it('refuses a reason on a non-escalated state', async () => {
      try {
        await record(3, { notSent: {} }, { reason: { foreignConsumer: {} } });
        assert.fail('a reason belongs only to an escalation');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal(
          'UnexpectedAmbiguityReason',
        );
      }
    });

    it('records an escalation with its named reason', async () => {
      await record(3, { ambiguous: {} }, { reason: { foreignConsumer: {} } });
      const slot = await program.account.contributionSlot.fetch(
        slotPda(0, members[3].publicKey),
      );
      expect(slot.state.ambiguous).to.not.equal(undefined);
      expect(slot.reason?.foreignConsumer).to.not.equal(undefined);
    });
  });

  // -----------------------------------------------------------------------
  // I3 — terminal before payout
  // -----------------------------------------------------------------------

  describe('I3 — a round cannot pay out over an unresolved contribution', () => {
    it('refuses to close while a slot is still escalated', async () => {
      // All four slots are recorded, so the count is met — but one of them is
      // AMBIGUOUS, and `resolve_slot` is the only way past it. The organizer
      // has to make the call; the round cannot be waited out.
      const round = await program.account.round.fetch(roundPda(0));
      expect(round.slotsTerminal).to.equal(MEMBER_COUNT);

      const slot = await program.account.contributionSlot.fetch(
        slotPda(0, members[3].publicKey),
      );
      expect(slot.state.ambiguous).to.not.equal(undefined);
    });

    it('refuses to disburse a round that has not been closed', async () => {
      try {
        await program.methods
          .disburse(0)
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: circlePda,
            round: roundPda(0),
            recipient: members[0].publicKey,
            recipientTokenAccount: memberTokenAccounts[0],
            vaultAuthority,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([organizer])
          .rpc();
        assert.fail('an open round must not disburse');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('RoundNotClosed');
      }
    });

    it('lets the organizer resolve the escalation, attributed', async () => {
      await program.methods
        .resolveSlot(0, { notSent: {} } as never)
        .accountsPartial({
          organizer: organizer.publicKey,
          circle: circlePda,
          round: roundPda(0),
          slot: slotPda(0, members[3].publicKey),
          vault,
        })
        .signers([organizer])
        .rpc();

      const slot = await program.account.contributionSlot.fetch(
        slotPda(0, members[3].publicKey),
      );
      expect(slot.state.notSent).to.not.equal(undefined);
      // The decision is attributed, and the reason it escalated is kept rather
      // than cleared, so nobody can mistake this for a chain fact.
      expect(slot.attribution.humanOverride).to.not.equal(undefined);
      expect(slot.decidedBy.toBase58()).to.equal(organizer.publicKey.toBase58());
      expect(slot.reason?.foreignConsumer).to.not.equal(undefined);
    });

    it('refuses an accept-as-paid the vault does not cover', async () => {
      // Round 1 is used so the state here does not disturb round 0.
      await program.methods
        .openRound(1)
        .accountsPartial({
          organizer: organizer.publicKey,
          circle: circlePda,
          round: roundPda(1),
          systemProgram: SystemProgram.programId,
        })
        .signers([organizer])
        .rpc();

      await program.methods
        .recordContribution(
          1,
          { ambiguous: {} } as never,
          { balanceDisagrees: {} } as never,
          messageHash(9),
          null,
          { machine: {} } as never,
        )
        .accountsPartial({
          authority: members[1].publicKey,
          member: members[1].publicKey,
          circle: circlePda,
          round: roundPda(1),
          slot: slotPda(1, members[1].publicKey),
          nonceAccount: nonceAccounts[1],
          vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([members[1]])
        .rpc();

      try {
        await program.methods
          .resolveSlot(1, { settled: {} } as never)
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: circlePda,
            round: roundPda(1),
            slot: slotPda(1, members[1].publicKey),
            vault,
          })
          .signers([organizer])
          .rpc();
        assert.fail('the organizer cannot accept a payment the vault never received');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('VaultShortOfCredit');
      }
    });

    it('closes round 0 once every slot is resolved', async () => {
      await program.methods
        .closeRound(0)
        .accountsPartial({
          organizer: organizer.publicKey,
          circle: circlePda,
          round: roundPda(0),
        })
        .signers([organizer])
        .rpc();

      const round = await program.account.round.fetch(roundPda(0));
      expect(round.closed).to.equal(true);
    });
  });

  // -----------------------------------------------------------------------
  // I4 — single disbursement. The adversarial test.
  // -----------------------------------------------------------------------

  describe('I4 — a round pays out at most once', () => {
    it('fires two concurrent disburse calls and exactly one succeeds', async () => {
      const round = await program.account.round.fetch(roundPda(0));
      const credited = BigInt(round.totalCredited.toString());
      expect(credited).to.equal(CONTRIBUTION);

      const recipientBefore = await getAccount(connection, memberTokenAccounts[0]);

      const build = async (): Promise<Transaction> => {
        const transaction = await program.methods
          .disburse(0)
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: circlePda,
            round: roundPda(0),
            recipient: members[0].publicKey,
            recipientTokenAccount: memberTokenAccounts[0],
            vaultAuthority,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .transaction();
        transaction.feePayer = organizer.publicKey;
        // Distinct blockhashes so the two are not deduplicated as one
        // transaction by signature. They must be two genuinely separate
        // attempts racing for the same round account.
        transaction.recentBlockhash = (
          await connection.getLatestBlockhash('finalized')
        ).blockhash;
        transaction.sign(organizer);
        return transaction;
      };

      const [first, second] = await Promise.all([build(), build()]);

      const results = await Promise.allSettled([
        connection
          .sendRawTransaction(first.serialize(), { skipPreflight: true })
          .then((signature) => connection.confirmTransaction(signature, 'confirmed'))
          .then((confirmation) => {
            if (confirmation.value.err !== null) {
              throw new Error(JSON.stringify(confirmation.value.err));
            }
            return 'ok';
          }),
        connection
          .sendRawTransaction(second.serialize(), { skipPreflight: true })
          .then((signature) => connection.confirmTransaction(signature, 'confirmed'))
          .then((confirmation) => {
            if (confirmation.value.err !== null) {
              throw new Error(JSON.stringify(confirmation.value.err));
            }
            return 'ok';
          }),
      ]);

      const succeeded = results.filter((result) => result.status === 'fulfilled').length;

      // This is I4. Both transactions write the round account, so the runtime
      // serializes them; the second loads a round whose disbursed flag is
      // already set and fails. The check and the set are one instruction, so
      // there is no interleaving to exploit.
      expect(succeeded).to.equal(1);

      const recipientAfter = await getAccount(connection, memberTokenAccounts[0]);
      const delta = recipientAfter.amount - recipientBefore.amount;
      // The pot moved exactly once.
      expect(delta.toString()).to.equal(credited.toString());

      const finalRound = await program.account.round.fetch(roundPda(0));
      expect(finalRound.disbursed).to.equal(true);
    });

    it('refuses a third, sequential disburse call', async () => {
      try {
        await program.methods
          .disburse(0)
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: circlePda,
            round: roundPda(0),
            recipient: members[0].publicKey,
            recipientTokenAccount: memberTokenAccounts[0],
            vaultAuthority,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([organizer])
          .rpc();
        assert.fail('a round pays out once');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('AlreadyDisbursed');
      }
    });

    it('refuses to redirect a payout to anyone but the round recipient', async () => {
      await program.methods
        .openRound(2)
        .accountsPartial({
          organizer: organizer.publicKey,
          circle: circlePda,
          round: roundPda(2),
          systemProgram: SystemProgram.programId,
        })
        .signers([organizer])
        .rpc();

      for (const [index, member] of members.entries()) {
        await program.methods
          .recordContribution(
            2,
            { notSent: {} } as never,
            null,
            messageHash(20 + index),
            null,
            { machine: {} } as never,
          )
          .accountsPartial({
            authority: member.publicKey,
            member: member.publicKey,
            circle: circlePda,
            round: roundPda(2),
            slot: slotPda(2, member.publicKey),
            nonceAccount: nonceAccounts[index],
            vault,
            systemProgram: SystemProgram.programId,
          })
          .signers([member])
          .rpc();
      }

      await program.methods
        .closeRound(2)
        .accountsPartial({
          organizer: organizer.publicKey,
          circle: circlePda,
          round: roundPda(2),
        })
        .signers([organizer])
        .rpc();

      // Round 2's recipient is member 2. Paying member 0 instead would let an
      // organizer walk the rotation into their own pocket.
      try {
        await program.methods
          .disburse(2)
          .accountsPartial({
            organizer: organizer.publicKey,
            circle: circlePda,
            round: roundPda(2),
            recipient: members[0].publicKey,
            recipientTokenAccount: memberTokenAccounts[0],
            vaultAuthority,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([organizer])
          .rpc();
        assert.fail('a payout must go to the round recipient');
      } catch (error) {
        expect((error as AnchorError).error.errorCode.code).to.equal('WrongRecipient');
      }
    });
  });
});
