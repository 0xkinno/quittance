/**
 * `@quittance/harness` — the fault-injection campaign driver.
 *
 * Two arms, one corpus, one device, never pooled. The baseline is the
 * standard mobile pattern written honestly; if it survives a fault, that is
 * reported as it stands. A control that could disprove the claim is the only
 * reason the claim is worth anything.
 */

export * from './adb.ts';
export * from './faults.ts';
export * from './baseline.ts';
export * from './campaign.ts';
