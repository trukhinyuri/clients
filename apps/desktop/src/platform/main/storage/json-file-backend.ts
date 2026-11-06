import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { NodeUtils } from "@bitwarden/node/node-utils";

import { isSnapStore, isWindowsPortable } from "../../../main/platform-utils.main";

import { StoreFile } from "./storage-backend";

/**
 * The pauses before each retry of the rename when another process holds the file (on Windows an
 * antivirus or the search indexer may hold the file it is just scanning): a second in all.
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 370];

const RETRIABLE_RENAME_CODES = ["EPERM", "EACCES", "EBUSY"];

/** Codes a `chmod` fails with on filesystems without POSIX permissions (FAT, exFAT); the mode does not apply there. */
const IGNORED_CHMOD_CODES = ["ENOSYS", "EINVAL", "EPERM"];

/** Never notified; `Atomics.wait` on it is a sleep for the given time. */
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

const OPEN = Buffer.from("{\n");
const SEPARATOR = Buffer.from(",\n");
const CLOSE = Buffer.from("\n}");
const EMPTY = Buffer.from("{}");

function errorCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? "";
}

function hasOwn(store: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(store, key);
}

/**
 * Serializes one key the way `JSON.stringify(store, undefined, "\t")` writes it inside the
 * top-level object: nested values are indented one level, and `toJSON` receives the key.
 * Null when JSON.stringify leaves the value out (undefined, functions, symbols).
 */
function serializeEntry(key: string, value: unknown): Buffer | null {
  // A computed key creates an own property also for "__proto__".
  const json = JSON.stringify({ [key]: value }, undefined, "\t");
  return json === "{}" ? null : Buffer.from(json.slice(OPEN.length, -CLOSE.length));
}

/**
 * Keeps the store in `data.json` in the given directory, in the format electron-store wrote it:
 * tab-indented JSON. A write replaces the file through a temporary file (write, fsync, rename),
 * without reading or parsing the file it replaces.
 *
 * The serialized form of every key is kept between writes, and a write serializes only the keys
 * that changed. A store holds one large key (the ciphers) that changes on sync and many small ones
 * that change on almost every click, so most writes serialize a few bytes instead of the whole
 * store. The bytes written are those of `JSON.stringify(store, undefined, "\t")`.
 *
 * {@link write} does the file I/O on libuv's thread pool; only the rename of the temporary file
 * runs on the main thread, so a {@link writeSync} (at shutdown) and a background write still in
 * flight cannot replace the file out of order: the file always ends up holding the latest write.
 */
export class JsonFileBackend implements StoreFile {
  private readonly filePath: string;
  private readonly fileMode: number;

  /** Serialized `\t"key": value` entries, or null for values JSON.stringify leaves out. */
  private readonly entries = new Map<string, Buffer | null>();
  private lastStartedWrite = 0;
  private lastCompletedWrite = 0;
  /** The temporary file of the background write in flight, if any. */
  private backgroundTempPath: string | null = null;
  private backgroundQueue: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    if (!fs.existsSync(dir)) {
      NodeUtils.mkdirpSync(dir, "700");
    }
    this.filePath = path.join(dir, "data.json");
    this.fileMode = isWindowsPortable() ? 0o666 : 0o600;
  }

  read(): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      if (errorCode(e) === "ENOENT") {
        return {};
      }
      throw e;
    }

    let store: unknown;
    try {
      // An editor may have saved the file with a byte order mark, which JSON.parse refuses.
      store = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      // JSON.parse quotes the text around the failure, which here is the vault data; name the file only.
      throw new SyntaxError(`The file "${this.filePath}" is not valid JSON.`);
    }
    if (store == null || typeof store !== "object" || Array.isArray(store)) {
      return {};
    }
    return { ...(store as Record<string, unknown>) };
  }

  async write(
    store: Readonly<Record<string, unknown>>,
    changedKeys: ReadonlySet<string>,
  ): Promise<void> {
    // Runs before the first await, so the caller may change the store as soon as this returns.
    const data = this.serialize(store, changedKeys);
    const id = ++this.lastStartedWrite;

    // electron-store wrote in place inside the Snap. An in-place write still running when the app
    // quits would leave a truncated file, so it stays synchronous.
    if (isSnapStore()) {
      this.writeInPlace(this.prepareTarget(), data);
      this.lastCompletedWrite = id;
      return;
    }

    const run = this.backgroundQueue.then(() => this.replaceInBackground(data, id));
    this.backgroundQueue = run.catch((): void => undefined);
    return run;
  }

  writeSync(store: Readonly<Record<string, unknown>>, changedKeys: ReadonlySet<string>): void {
    const data = this.serialize(store, changedKeys);
    const id = ++this.lastStartedWrite;
    const targetPath = this.prepareTarget();

    if (isSnapStore()) {
      this.writeInPlace(targetPath, data);
      this.lastCompletedWrite = id;
      return;
    }

    try {
      this.writeAtomically(targetPath, data);
    } catch (e) {
      // Windows sometimes refuses the rename with EXDEV although both paths are in one directory
      // (electron-store#106); electron-store wrote in place then. Any other failure leaves the
      // previous file in place, and the caller keeps the changes for its next write.
      if (errorCode(e) !== "EXDEV") {
        throw e;
      }
      this.writeInPlace(targetPath, data);
    }
    this.lastCompletedWrite = id;

    // The background write still in flight will not rename its file; remove it now, as the app
    // may exit before that write gets to. Unlinking the file it still has open is fine.
    if (this.backgroundTempPath != null) {
      this.removeQuietly(this.backgroundTempPath);
    }
  }

  /**
   * Returns the bytes of `JSON.stringify(store, undefined, "\t")`, serializing only the keys in
   * `changedKeys` and the keys that were not serialized before.
   */
  private serialize(
    store: Readonly<Record<string, unknown>>,
    changedKeys: ReadonlySet<string>,
  ): Buffer {
    for (const key of changedKeys) {
      if (hasOwn(store, key)) {
        this.entries.set(key, serializeEntry(key, store[key]));
      } else {
        this.entries.delete(key);
      }
    }

    // JSON.stringify visits the enumerable own string keys in the order Object.keys returns them.
    const keys = Object.keys(store);
    const chunks: Buffer[] = [];
    for (const key of keys) {
      let entry = this.entries.get(key);
      if (entry === undefined) {
        entry = serializeEntry(key, store[key]);
        this.entries.set(key, entry);
      }
      if (entry !== null) {
        chunks.push(chunks.length === 0 ? OPEN : SEPARATOR, entry);
      }
    }
    if (this.entries.size !== keys.length) {
      // Keys removed from the store without being reported as changed.
      for (const key of this.entries.keys()) {
        if (!hasOwn(store, key)) {
          this.entries.delete(key);
        }
      }
    }

    if (chunks.length === 0) {
      return EMPTY;
    }
    chunks.push(CLOSE);
    return Buffer.concat(chunks);
  }

  /** A write that started after write `id` has already replaced the file. */
  private isSuperseded(id: number): boolean {
    return id < this.lastCompletedWrite;
  }

  private async replaceInBackground(data: Buffer, id: number): Promise<void> {
    if (this.isSuperseded(id)) {
      return;
    }
    let targetPath: string;
    try {
      targetPath = await this.prepareTargetInBackground();
    } catch (e) {
      if (this.isSuperseded(id)) {
        return;
      }
      throw e;
    }
    if (this.isSuperseded(id)) {
      return;
    }
    const tempPath = this.tempPath(targetPath);
    let handle: fs.promises.FileHandle | null = null;
    let createdTemp = false;
    try {
      // Another instance may own a colliding path. Do not remove anything until this write's
      // exclusive open has succeeded.
      const openedHandle = await fs.promises.open(tempPath, "wx", this.fileMode);
      handle = openedHandle;
      createdTemp = true;
      this.backgroundTempPath = tempPath;
      if (this.isSuperseded(id)) {
        await openedHandle.close();
        handle = null;
        this.removeQuietly(tempPath);
        return;
      }
      try {
        // The mode given to open is reduced by the umask; set the exact mode before any data goes in.
        await this.chmodInBackground(() => openedHandle.chmod(this.fileMode));
        await openedHandle.writeFile(data);
        await openedHandle.sync();
      } finally {
        await openedHandle.close();
        handle = null;
      }
      if (await this.renameInBackground(tempPath, targetPath, id)) {
        this.lastCompletedWrite = id;
      }
    } catch (e) {
      if (handle != null) {
        try {
          await handle.close();
        } catch {
          // The original write error is more useful than a close error.
        }
      }
      if (createdTemp) {
        await this.removeQuietlyInBackground(tempPath);
      }
      // A later synchronous write already persisted the latest cache. Its predecessor must not
      // create a spurious error/retry after it was superseded.
      if (this.isSuperseded(id)) {
        return;
      }
      if (errorCode(e) !== "EXDEV") {
        throw e;
      }
      this.writeInPlace(targetPath, data);
      this.lastCompletedWrite = id;
    } finally {
      this.backgroundTempPath = null;
    }
  }

  /**
   * Moves the temporary file over the target, retrying while another process holds the target.
   * False when a later write replaced the file in the meantime; the temporary file is removed then.
   */
  private async renameInBackground(from: string, to: string, id: number): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (this.isSuperseded(id)) {
        await this.removeQuietlyInBackground(from);
        return false;
      }
      try {
        // The rename itself runs on the main thread (it takes well under a millisecond): a
        // writeSync runs between two tasks of that thread, so it replaces the file either before
        // this point, which isSuperseded catches, or after this rename.
        fs.renameSync(from, to);
        return true;
      } catch (e) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !RETRIABLE_RENAME_CODES.includes(errorCode(e))) {
          throw e;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** Makes sure the directory exists, as it may have been removed while the app ran. */
  private prepareTarget(): string {
    const targetPath = this.targetPath();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    return targetPath;
  }

  private async prepareTargetInBackground(): Promise<string> {
    const targetPath = await this.targetPathInBackground();
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    return targetPath;
  }

  /**
   * The file a write replaces: `data.json`, or the file a symlink at that path points to, so a
   * link into another directory keeps pointing there instead of being replaced by a plain file.
   * The temporary file goes next to it, so the rename stays within one filesystem.
   */
  private targetPath(): string {
    if (!fs.lstatSync(this.filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return this.filePath;
    }
    try {
      return fs.realpathSync(this.filePath);
    } catch {
      // The link points at a file that does not exist yet: follow the links to where it belongs.
      let target = this.filePath;
      const followed = new Set<string>();
      while (
        !followed.has(target) &&
        fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
      ) {
        followed.add(target);
        target = path.resolve(path.dirname(target), fs.readlinkSync(target));
      }
      return target;
    }
  }

  private async targetPathInBackground(): Promise<string> {
    if (!(await this.isSymbolicLink(this.filePath))) {
      return this.filePath;
    }
    try {
      return await fs.promises.realpath(this.filePath);
    } catch {
      let target = this.filePath;
      const followed = new Set<string>();
      while (!followed.has(target) && (await this.isSymbolicLink(target))) {
        followed.add(target);
        target = path.resolve(path.dirname(target), await fs.promises.readlink(target));
      }
      return target;
    }
  }

  private async isSymbolicLink(filePath: string): Promise<boolean> {
    try {
      return (await fs.promises.lstat(filePath)).isSymbolicLink();
    } catch (e) {
      if (errorCode(e) === "ENOENT") {
        return false;
      }
      throw e;
    }
  }

  /**
   * Another instance of the app (a deep link opens one before the single-instance lock runs)
   * may write at the same time, so each write gets a temporary file of its own and refuses
   * one that is already there.
   */
  private tempPath(targetPath: string): string {
    return `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  }

  private writeAtomically(targetPath: string, data: Buffer): void {
    const tempPath = this.tempPath(targetPath);
    const fd = fs.openSync(tempPath, "wx", this.fileMode);
    try {
      try {
        this.chmod(() => fs.fchmodSync(fd, this.fileMode));
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.rename(tempPath, targetPath);
    } catch (e) {
      this.removeQuietly(tempPath);
      throw e;
    }
  }

  private writeInPlace(targetPath: string, data: Buffer): void {
    const fd = fs.openSync(targetPath, "w", this.fileMode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.chmod(() => fs.chmodSync(targetPath, this.fileMode));
  }

  private chmod(change: () => void): void {
    try {
      change();
    } catch (e) {
      if (!IGNORED_CHMOD_CODES.includes(errorCode(e))) {
        throw e;
      }
    }
  }

  private async chmodInBackground(change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (e) {
      if (!IGNORED_CHMOD_CODES.includes(errorCode(e))) {
        throw e;
      }
    }
  }

  private removeQuietly(tempPath: string): void {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // The file that could not be written may also be one that cannot be removed right now.
    }
  }

  private async removeQuietlyInBackground(tempPath: string): Promise<void> {
    try {
      await fs.promises.rm(tempPath, { force: true });
    } catch {
      // As above.
    }
  }

  private rename(from: string, to: string): void {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(from, to);
        return;
      } catch (e) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !RETRIABLE_RENAME_CODES.includes(errorCode(e))) {
          throw e;
        }
        // The write is synchronous, so the wait is too.
        Atomics.wait(sleepCell, 0, 0, delay);
      }
    }
  }
}
