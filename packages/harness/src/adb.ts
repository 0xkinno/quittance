/**
 * The device, over adb.
 *
 * Every fault in the corpus is injected through this module, against a real
 * phone. That matters more than it sounds: killing a process in a simulator
 * proves something about the simulator, and the claim being made here is
 * about what Android actually does to a backgrounded app during a wallet
 * handoff.
 *
 * Every call records the device it ran against. A campaign row without a
 * device fingerprint is not evidence, so the fingerprint is read once at the
 * start of a run and carried into every row rather than assumed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface DeviceInfo {
  readonly serial: string;
  readonly model: string;
  readonly androidVersion: string;
  readonly fingerprint: string;
  readonly walletPackage: string;
  readonly walletVersion: string;
}

export class AdbError extends Error {
  readonly command: string;

  constructor(command: string, detail: string) {
    super(`adb ${command} failed: ${detail}`);
    this.name = 'AdbError';
    this.command = command;
  }
}

export class Adb {
  private readonly serial: string;

  constructor(serial: string) {
    this.serial = serial;
  }

  private async exec(args: readonly string[], timeoutMs = 30_000): Promise<string> {
    try {
      const { stdout } = await run('adb', ['-s', this.serial, ...args], {
        timeout: timeoutMs,
        encoding: 'utf8',
      });
      return stdout.trim();
    } catch (error) {
      throw new AdbError(
        args.join(' '),
        error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error),
      );
    }
  }

  /**
   * List attached devices, with their state.
   *
   * `unauthorized` is surfaced distinctly from absent, because the two need
   * completely different things from a person: one needs a cable, the other
   * needs a tap on a dialog.
   */
  static async listDevices(): Promise<
    ReadonlyArray<{ readonly serial: string; readonly state: string }>
  > {
    const { stdout } = await run('adb', ['devices'], { encoding: 'utf8' });
    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [serial, state] = line.split(/\s+/);
        return { serial: serial ?? '', state: state ?? 'unknown' };
      });
  }

  /**
   * Read everything that identifies this device and this wallet.
   *
   * Called once per campaign run. These values go into every row and into the
   * evidence manifest, so a reader can tell exactly what hardware and what
   * wallet version produced a given number.
   */
  async describe(walletPackage: string): Promise<DeviceInfo> {
    const [model, androidVersion, fingerprint] = await Promise.all([
      this.exec(['shell', 'getprop', 'ro.product.model']),
      this.exec(['shell', 'getprop', 'ro.build.version.release']),
      this.exec(['shell', 'getprop', 'ro.build.fingerprint']),
    ]);

    let walletVersion = 'not installed';
    try {
      const dump = await this.exec(['shell', 'dumpsys', 'package', walletPackage]);
      walletVersion = /versionName=(\S+)/.exec(dump)?.[1] ?? 'unknown';
    } catch {
      walletVersion = 'not installed';
    }

    return {
      serial: this.serial,
      model,
      androidVersion,
      fingerprint,
      walletPackage,
      walletVersion,
    };
  }

  // -------------------------------------------------------------------------
  // Faults
  // -------------------------------------------------------------------------

  /**
   * F1, F2, F3, F10 — kill the app's process.
   *
   * `am force-stop` is the closest a test can get to what the Android
   * low-memory killer does to a backgrounded app, and it is what the device
   * does to this app during a wallet handoff when memory is tight. It does
   * not run any shutdown path, which is the point: the app gets no chance to
   * write anything on the way out.
   */
  async forceStop(packageName: string): Promise<void> {
    await this.exec(['shell', 'am', 'force-stop', packageName]);
  }

  /** F4 — airplane mode, to cut the network mid-broadcast. */
  async setAirplaneMode(enabled: boolean): Promise<void> {
    await this.exec([
      'shell',
      'cmd',
      'connectivity',
      'airplane-mode',
      enabled ? 'enable' : 'disable',
    ]);
  }

  /**
   * F5 — a cold boot between broadcast and resolution.
   *
   * The hardest fault in the corpus and the most convincing one. Nothing in
   * the app's memory survives, the MMKV file is all that is left, and the
   * verdict has to be reachable from it alone.
   */
  async reboot(waitMs = 90_000): Promise<void> {
    await this.exec(['reboot']);
    await this.waitForDevice(waitMs);
  }

  async waitForDevice(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // `wait-for-device` returns as soon as adb can see it, which is before
    // the system is usable. Polling `sys.boot_completed` is what actually
    // tells us the device can run an app.
    await this.exec(['wait-for-device'], timeoutMs);
    while (Date.now() < deadline) {
      try {
        const booted = await this.exec(['shell', 'getprop', 'sys.boot_completed'], 10_000);
        if (booted === '1') return;
      } catch {
        // Still coming up. Keep waiting until the deadline rather than
        // treating a transient failure as a dead device.
      }
      await sleep(2_000);
    }
    throw new AdbError('wait-for-device', `device did not finish booting within ${timeoutMs} ms`);
  }

  /** Launch the app at a given deep link. */
  async launch(packageName: string, deepLink: string | null = null): Promise<void> {
    if (deepLink === null) {
      await this.exec(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']);
      return;
    }
    await this.exec(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deepLink]);
  }

  /** Whether a package currently has a running process. */
  async isRunning(packageName: string): Promise<boolean> {
    try {
      const pid = await this.exec(['shell', 'pidof', packageName]);
      return pid.length > 0;
    } catch {
      return false;
    }
  }

  /** Pull the app's exported intent log off the device. */
  async pullIntentLog(packageName: string, remotePath: string): Promise<string> {
    return this.exec(['shell', 'run-as', packageName, 'cat', remotePath]);
  }

  /** Read structured probe output. */
  async logcat(tag: string): Promise<string> {
    return this.exec(['logcat', '-d', '-s', `${tag}:V`]);
  }

  async clearLogcat(): Promise<void> {
    await this.exec(['logcat', '-c']);
  }

  /** Whether the wallet is currently the foreground app. */
  async foregroundPackage(): Promise<string> {
    const dump = await this.exec(['shell', 'dumpsys', 'activity', 'activities']);
    return /mResumedActivity.*?\s([a-zA-Z0-9_.]+)\//.exec(dump)?.[1] ?? '';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolve the one device a campaign will run against.
 *
 * Refuses to proceed with more than one attached, because a fault injected
 * into the wrong phone produces a row that looks valid and is not.
 */
export async function resolveSingleDevice(preferredSerial: string | null): Promise<string> {
  const devices = await Adb.listDevices();
  const ready = devices.filter((device) => device.state === 'device');
  const unauthorized = devices.filter((device) => device.state === 'unauthorized');

  if (unauthorized.length > 0 && ready.length === 0) {
    throw new AdbError(
      'devices',
      'the device is attached but unauthorized. Unlock the phone and accept the ' +
        '"Allow USB debugging" prompt.',
    );
  }
  if (ready.length === 0) {
    throw new AdbError('devices', 'no device is attached.');
  }
  if (preferredSerial !== null) {
    const match = ready.find((device) => device.serial === preferredSerial);
    if (match === undefined) {
      throw new AdbError('devices', `device ${preferredSerial} is not attached.`);
    }
    return match.serial;
  }
  if (ready.length > 1) {
    throw new AdbError(
      'devices',
      `${ready.length} devices are attached. Set ANDROID_DEVICE_SERIAL so a fault cannot ` +
        'be injected into the wrong phone.',
    );
  }
  return (ready[0] as { serial: string }).serial;
}
