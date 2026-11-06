/**
 * The desktop app's persistent key-value store, as the storage service uses it.
 * Designed to be composable so that implementations can wrap other backends to add
 * behavior like caching.
 */
export interface StorageBackend {
  /** Read the entire store. Callers must not modify the returned object. */
  read(): Record<string, unknown>;
  /** Store `value` under `key`. */
  set(key: string, value: unknown): void;
  /** Remove `key` from the store. */
  remove(key: string): void;
  /** Persist any pending changes before returning. No-op if nothing is pending. */
  flush(): void;
}

/**
 * A file that holds the whole store. {@link StoreFile.write} and {@link StoreFile.writeSync}
 * receive the keys that changed since the previous write, so an implementation can reuse what it
 * serialized for the other keys. A caller runs one write at a time.
 */
export interface StoreFile {
  /** Read the entire store from the file. */
  read(): Record<string, unknown>;
  /**
   * Serialize `store` before returning, then replace the file without blocking the calling thread
   * on file I/O. The returned promise rejects with the file error when the file stays as it was.
   */
  write(store: Readonly<Record<string, unknown>>, changedKeys: ReadonlySet<string>): Promise<void>;
  /**
   * Replace the file before returning. A write started earlier with {@link StoreFile.write} that
   * has not completed yet no longer changes the file.
   */
  writeSync(store: Readonly<Record<string, unknown>>, changedKeys: ReadonlySet<string>): void;
}
