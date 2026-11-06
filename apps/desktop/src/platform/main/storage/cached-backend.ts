import { StorageBackend, StoreFile } from "./storage-backend";

const DEBOUNCE_DELAY_MS = 200;
const MAX_WAIT_MS = 5000;

/**
 * Keeps the store in memory and writes it to a {@link StoreFile} in the background.
 * - Reads are always served from memory, loaded from the file during construction.
 * - Changes apply to memory immediately and are written after a short delay: each change resets
 *   a delay timer ({@link DEBOUNCE_DELAY_MS}), and a separate max-wait timer ({@link MAX_WAIT_MS})
 *   ensures continuous changes can't defer the write indefinitely. One write runs at a time;
 *   changes made while it runs are written right after it.
 * - A failed background write is reported to the `onWriteError` callback and retried after the
 *   next debounce delay; its changes remain dirty until that retry succeeds.
 * - Call {@link flush} before shutdown to write pending changes before returning (e.g. in
 *   Electron's `will-quit`).
 */
export class CachedBackend implements StorageBackend {
  private cache: Record<string, unknown>;
  /** Keys changed since the last write started. */
  private changedKeys = new Set<string>();
  private writeInFlight = false;
  /** Increments after a synchronous shutdown write supersedes a background write. */
  private syncFlushCount = 0;

  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: StoreFile,
    private readonly onWriteError: (error: unknown) => void,
  ) {
    this.cache = file.read();
  }

  read(): Record<string, unknown> {
    return this.cache;
  }

  set(key: string, value: unknown): void {
    this.cache = { ...this.cache, [key]: value };
    this.changedKeys.add(key);
    this.scheduleWrite();
  }

  remove(key: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.cache, key)) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [key]: _, ...rest } = this.cache;
    this.cache = rest;
    this.changedKeys.add(key);
    this.scheduleWrite();
  }

  flush(): void {
    this.clearTimers();
    // A background write that has not completed yet would be lost when the app exits now.
    if (this.changedKeys.size === 0 && !this.writeInFlight) {
      return;
    }
    const changedKeys = this.takeChangedKeys();
    try {
      this.file.writeSync(this.cache, changedKeys);
      this.syncFlushCount++;
    } catch (e) {
      this.restoreChangedKeys(changedKeys);
      throw e;
    }
  }

  private writeInBackground(): void {
    if (this.writeInFlight || this.changedKeys.size === 0) {
      return;
    }
    this.clearTimers();
    const changedKeys = this.takeChangedKeys();
    this.writeInFlight = true;
    const syncFlushCount = this.syncFlushCount;
    let write: Promise<void>;
    try {
      write = this.file.write(this.cache, changedKeys);
    } catch (e) {
      this.handleWriteError(e, changedKeys, syncFlushCount);
      return;
    }
    write.then(
      () => {
        this.writeInFlight = false;
        // Changes made while the write ran have waited their delay already.
        this.writeInBackground();
      },
      (e: unknown) => this.handleWriteError(e, changedKeys, syncFlushCount),
    );
  }

  private handleWriteError(
    e: unknown,
    changedKeys: Set<string>,
    startedBeforeSyncFlushCount: number,
  ): void {
    this.writeInFlight = false;
    if (startedBeforeSyncFlushCount !== this.syncFlushCount) {
      // flush() has already written this snapshot and any newer cached changes.
      this.writeInBackground();
      return;
    }
    this.restoreChangedKeys(changedKeys);
    try {
      this.onWriteError(e);
    } catch {
      // A logging failure must not become an uncaught exception from a timer callback.
    }
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    // Reset the debounce delay timer on every change
    if (this.delayTimer != null) {
      clearTimeout(this.delayTimer);
    }
    this.delayTimer = setTimeout(() => {
      this.delayTimer = null;
      this.writeInBackground();
    }, DEBOUNCE_DELAY_MS);

    // Start a max-wait timer on the first change after a write,
    // so continuous changes can't defer the write forever
    if (this.maxWaitTimer == null) {
      this.maxWaitTimer = setTimeout(() => {
        this.maxWaitTimer = null;
        this.writeInBackground();
      }, MAX_WAIT_MS);
    }
  }

  private takeChangedKeys(): Set<string> {
    const changedKeys = this.changedKeys;
    this.changedKeys = new Set();
    return changedKeys;
  }

  private restoreChangedKeys(changedKeys: Set<string>): void {
    for (const key of changedKeys) {
      this.changedKeys.add(key);
    }
  }

  private clearTimers(): void {
    if (this.delayTimer != null) {
      clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
    if (this.maxWaitTimer != null) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }
}
