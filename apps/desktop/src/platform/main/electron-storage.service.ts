// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { ipcMain } from "electron";
import { Subject } from "rxjs";

import {
  AbstractStorageService,
  StorageUpdate,
} from "@bitwarden/common/platform/abstractions/storage.service";

import { StorageBackend } from "./storage/storage-backend";

interface BaseOptions<T extends string> {
  action: T;
  key: string;
}

interface SaveOptions extends BaseOptions<"save"> {
  obj: unknown;
}

type Options = BaseOptions<"get"> | BaseOptions<"has"> | SaveOptions | BaseOptions<"remove">;

function cloneForMainProcess<T>(value: T): T {
  const json = JSON.stringify(value);
  return json === undefined ? (undefined as T) : (JSON.parse(json) as T);
}

export class ElectronStorageService implements AbstractStorageService {
  private updatesSubject = new Subject<StorageUpdate>();
  updates$;

  constructor(private backend: StorageBackend) {
    this.updates$ = this.updatesSubject.asObservable();

    ipcMain.handle("storageService", (event, options: Options) => {
      switch (options.action) {
        case "get":
          // Electron structured-clones IPC responses, so avoid cloning a large vault twice.
          return this.getValue(options.key);
        case "has":
          return this.has(options.key);
        case "save":
          // Electron structured-clones IPC requests before this handler runs.
          return this.saveFromIpc(options.key, options.obj);
        case "remove":
          return this.remove(options.key);
      }
    });
  }

  get valuesRequireDeserialization(): boolean {
    return true;
  }

  dispose(): void {
    this.backend.flush();
  }

  get<T>(key: string): Promise<T> {
    // Main-process callers can otherwise mutate an object held by CachedBackend without marking
    // the key dirty, leaving its cached serialized fragment stale.
    return Promise.resolve(cloneForMainProcess(this.getValue<T>(key)));
  }

  has(key: string): Promise<boolean> {
    const val = this.backend.read()[key];
    return Promise.resolve(val != null);
  }

  save(key: string, obj: unknown): Promise<void> {
    if (obj === undefined) {
      return this.remove(key);
    }
    if (obj instanceof Set) {
      obj = Array.from(obj);
    }
    return this.saveValue(key, cloneForMainProcess(obj));
  }

  private getValue<T>(key: string): T | null {
    const value = this.backend.read()[key] as T;
    return value != null ? value : null;
  }

  private saveFromIpc(key: string, obj: unknown): Promise<void> {
    return this.saveValue(key, obj);
  }

  private saveValue(key: string, obj: unknown): Promise<void> {
    if (obj === undefined) {
      return this.remove(key);
    }

    if (obj instanceof Set) {
      obj = Array.from(obj);
    }

    this.backend.set(key, obj);
    this.updatesSubject.next({ key, updateType: "save" });
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.backend.remove(key);
    this.updatesSubject.next({ key, updateType: "remove" });
    return Promise.resolve();
  }
}
