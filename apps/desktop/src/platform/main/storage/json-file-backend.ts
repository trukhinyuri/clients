import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { NodeUtils } from "@bitwarden/node/node-utils";

import { isSnapStore, isWindowsPortable } from "../../../main/platform-utils.main";

import { StorageBackend } from "./storage-backend";

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

function errorCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? "";
}

/**
 * Keeps the store in `data.json` in the given directory, in the format electron-store wrote it:
 * tab-indented JSON. A write serializes the store and replaces the file through a temporary file
 * (write, fsync, rename), without reading or parsing the file it replaces.
 */
export class JsonFileBackend implements StorageBackend {
  private readonly filePath: string;
  private readonly fileMode: number;

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

  write(store: Record<string, unknown>): void {
    const data = JSON.stringify(store, undefined, "\t");
    const targetPath = this.targetPath();
    // The directory may have been removed while the app ran.
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });

    // electron-store wrote in place inside the Snap; keep doing so there.
    if (isSnapStore()) {
      this.writeInPlace(targetPath, data);
      return;
    }

    try {
      this.writeAtomically(targetPath, data);
    } catch (e) {
      // Windows sometimes refuses the rename with EXDEV although both paths are in one directory
      // (electron-store#106); electron-store wrote in place then. Any other failure leaves the
      // previous file in place, and the caller keeps the store for its next write.
      if (errorCode(e) !== "EXDEV") {
        throw e;
      }
      this.writeInPlace(targetPath, data);
    }
  }

  update(updater: (store: Record<string, unknown>) => Record<string, unknown>): void {
    this.write(updater(this.read()));
  }

  flush(): void {
    // Writes are synchronous, nothing to flush.
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

  private writeAtomically(targetPath: string, data: string): void {
    // Another instance of the app (a deep link opens one before the single-instance lock runs)
    // may write at the same time, so each write gets a temporary file of its own and refuses
    // one that is already there. The file is only removed below once this write has created it.
    const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(tempPath, "wx", this.fileMode);
    try {
      try {
        // The mode given to openSync is reduced by the umask; set the exact mode before any data goes in.
        this.chmod(() => fs.fchmodSync(fd, this.fileMode));
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.rename(tempPath, targetPath);
    } catch (e) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // The file that could not be written may also be one that cannot be removed right now.
      }
      throw e;
    }
  }

  private writeInPlace(targetPath: string, data: string): void {
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
        // Writes are synchronous, so the wait is too.
        Atomics.wait(sleepCell, 0, 0, delay);
      }
    }
  }
}
