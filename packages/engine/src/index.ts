/**
 * `@quittance/engine` — the mechanism.
 *
 * Pure TypeScript. No React, no React Native, no platform globals. It is
 * imported unchanged by the app, by the offline verifier, and by the fault
 * harness, and it runs under plain Node against `MemoryIntentStore`. If it
 * ever stops doing that, the architecture is wrong: the verifier would no
 * longer be recomputing the same thing the app computed, and I6 would become
 * a claim about two codebases agreeing rather than one being deterministic.
 *
 * The one rule the whole package exists to enforce:
 *
 *   The phone records intent. The chain decides truth. The phone is never
 *   allowed to be the authority on whether money moved.
 */

export * from './types.ts';
export * from './canonical.ts';
export * from './intent.ts';
export * from './builder.ts';
export * from './capabilities.ts';
export * from './nonce-lease.ts';
export * from './store.ts';
export * from './chain.ts';
export * from './verdict.ts';
export * from './broadcaster.ts';
export * from './resolver.ts';
export * from './invariants.ts';
