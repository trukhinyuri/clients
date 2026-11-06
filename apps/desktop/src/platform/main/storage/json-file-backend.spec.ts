import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isSnapStore, isWindowsPortable } from "../../../main/platform-utils.main";

import { JsonFileBackend } from "./json-file-backend";

jest.mock("../../../main/platform-utils.main", () => ({
  isSnapStore: jest.fn(() => false),
  isWindowsPortable: jest.fn(() => false),
}));

type Store = Record<string, unknown>;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function keys(...names: string[]): Set<string> {
  return new Set(names);
}

function all(store: Store): Set<string> {
  return new Set(Object.keys(store));
}

function expected(store: Store): string {
  return JSON.stringify(store, undefined, "\t");
}

/** The prototype of the handles `fs.promises.open` returns, to intercept their methods. */
async function fileHandlePrototype(dir: string): Promise<fs.promises.FileHandle> {
  const probePath = path.join(dir, "probe");
  const handle = await fs.promises.open(probePath, "w");
  try {
    return Object.getPrototypeOf(handle);
  } finally {
    await handle.close();
    fs.rmSync(probePath);
  }
}

/** Makes the retry pauses of a background rename immediate, and records them. */
function immediateTimeouts(): jest.SpyInstance {
  return jest.spyOn(global, "setTimeout").mockImplementation(((callback: () => void) => {
    callback();
    return 0;
  }) as unknown as typeof setTimeout);
}

describe("JsonFileBackend", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-backend-"));
    filePath = path.join(dir, "data.json");
    (isSnapStore as jest.Mock).mockReturnValue(false);
    (isWindowsPortable as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("read", () => {
    it("creates the directory and reads an empty store when there is no file yet", () => {
      const nested = path.join(dir, "nested", "appdata");

      const sut = new JsonFileBackend(nested);

      expect(fs.existsSync(nested)).toBe(true);
      expect(sut.read()).toEqual({});
    });

    it("reads a store electron-store wrote", () => {
      fs.writeFileSync(filePath, '{\n\t"global_key": {\n\t\t"nested": [\n\t\t\t1\n\t\t]\n\t}\n}');

      const sut = new JsonFileBackend(dir);

      expect(sut.read()).toEqual({ global_key: { nested: [1] } });
    });

    it("reads a file an editor saved with a byte order mark", () => {
      fs.writeFileSync(filePath, '\uFEFF{"a": 1}');

      expect(new JsonFileBackend(dir).read()).toEqual({ a: 1 });
    });

    it.each(["[1, 2]", "null", '"text"'])("reads %s as an empty store", (content) => {
      fs.writeFileSync(filePath, content);

      expect(new JsonFileBackend(dir).read()).toEqual({});
    });

    it("throws on a file that is not JSON without quoting it, and leaves it untouched", () => {
      fs.writeFileSync(filePath, '{ "accessToken": "s3cret" oops');
      const sut = new JsonFileBackend(dir);

      let error: unknown;
      try {
        sut.read();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(SyntaxError);
      expect((error as Error).message).toContain(filePath);
      expect((error as Error).message).not.toContain("s3cret");
      expect(fs.readFileSync(filePath, "utf8")).toBe('{ "accessToken": "s3cret" oops');
    });
  });

  describe("serialization", () => {
    // Everything JSON.stringify treats specially: key order (integer-like keys first, in numeric
    // order; 2^32-1 is not an array index), values it drops or replaces, escaping, toJSON.
    const fixture: Store = {
      "10": "integer-like keys come first, in numeric order",
      "2": [1, 2.5, -0, 1e21, 1e-7, NaN, Infinity, null, true, undefined, () => 1, Symbol("s")],
      b: { nested: { deeper: { empty: {}, list: [] } }, "": "empty key" },
      a: 'ünïcödé 日本語 🎉 \u2028 \u0007 \uD800 lone surrogate "quoted" back\\slash\nnewline\ttab',
      "-1": "not an array index",
      "1.5": "neither",
      "01": "a leading zero makes a string key",
      "4294967295": "2^32-1 is not an array index",
      "4294967294": "2^32-2 is the largest array index",
      'key with "quotes", \\ and \n': null,
      dropped: undefined,
      fn: () => 1,
      sym: Symbol("x"),
      date: new Date(Date.UTC(2026, 10, 6, 12, 0, 0)),
      custom: {
        toJSON(key: string) {
          return `serialized as ${key}`;
        },
      },
      nestedUndefined: { keep: 1, drop: undefined, list: [undefined, 1] },
      ["__proto__"]: "an own property, not the prototype",
      emptyString: "",
      zero: 0,
      bool: false,
    };

    it("writes the bytes of JSON.stringify with tab indentation, as electron-store did", async () => {
      const sut = new JsonFileBackend(dir);

      await sut.write(fixture, all(fixture));

      expect(fs.readFileSync(filePath, "utf8")).toBe(expected(fixture));
      expect(fs.readFileSync(filePath).equals(Buffer.from(expected(fixture)))).toBe(true);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(JSON.parse(expected(fixture)));
    });

    it("writes the same bytes synchronously", () => {
      const sut = new JsonFileBackend(dir);

      sut.writeSync(fixture, all(fixture));

      expect(fs.readFileSync(filePath).equals(Buffer.from(expected(fixture)))).toBe(true);
    });

    it("writes the same bytes after changing, adding and removing keys", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write(fixture, all(fixture));

      const changed: Store = { ...fixture, "2": [9], b: { replaced: true }, added: { x: [{}] } };
      delete changed.a;
      await sut.write(changed, keys("2", "b", "added", "a"));
      expect(fs.readFileSync(filePath).equals(Buffer.from(expected(changed)))).toBe(true);

      const emptied: Store = { ...changed, "10": undefined, added: undefined };
      await sut.write(emptied, keys("10", "added"));
      expect(fs.readFileSync(filePath).equals(Buffer.from(expected(emptied)))).toBe(true);

      await sut.write({ zero: 0, "3": "first" }, all(emptied));
      expect(fs.readFileSync(filePath, "utf8")).toBe('{\n\t"3": "first",\n\t"zero": 0\n}');
    });

    it("writes {} for an empty store and for a store without serializable values", async () => {
      const sut = new JsonFileBackend(dir);

      await sut.write({}, keys());
      expect(fs.readFileSync(filePath, "utf8")).toBe("{}");

      await sut.write({ a: undefined, b: () => 1 }, keys("a", "b"));
      expect(fs.readFileSync(filePath, "utf8")).toBe("{}");

      await sut.write({ a: 1 }, keys("a"));
      expect(fs.readFileSync(filePath, "utf8")).toBe('{\n\t"a": 1\n}');
    });

    it("serializes only the keys reported as changed and the keys it has not seen", async () => {
      const sut = new JsonFileBackend(dir);
      const stringify = jest.spyOn(JSON, "stringify");

      await sut.write({ a: 1, b: 2, c: 3 }, keys());
      expect(stringify).toHaveBeenCalledTimes(3);

      stringify.mockClear();
      await sut.write({ a: 1, b: 20, c: 3, d: 4 }, keys("b"));

      expect(stringify).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(filePath, "utf8")).toBe(
        '{\n\t"a": 1,\n\t"b": 20,\n\t"c": 3,\n\t"d": 4\n}',
      );
    });

    it("writes what a key held when it was last reported changed", async () => {
      const sut = new JsonFileBackend(dir);
      const value = { n: 1 };
      await sut.write({ a: value }, keys("a"));

      value.n = 2;
      await sut.write({ a: value }, keys());
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ a: { n: 1 } });

      await sut.write({ a: value }, keys("a"));
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ a: { n: 2 } });
    });

    it("forgets a key removed without being reported, so it is serialized afresh when it returns", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1, b: 2 }, keys());

      await sut.write({ a: 1 }, keys());
      expect(fs.readFileSync(filePath, "utf8")).toBe('{\n\t"a": 1\n}');

      await sut.write({ a: 1, b: 3 }, keys());
      expect(fs.readFileSync(filePath, "utf8")).toBe('{\n\t"a": 1,\n\t"b": 3\n}');
    });
  });

  describe("write", () => {
    it("writes the store and reads it back", async () => {
      const store = { a: 1, b: { c: ["d"] } };
      const sut = new JsonFileBackend(dir);

      await sut.write(store, all(store));

      expect(fs.readFileSync(filePath, "utf8")).toBe(expected(store));
      expect(sut.read()).toEqual(store);
    });

    it("replaces the file without leaving temporary files behind", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;

      await sut.write({ a: 2 }, keys("a"));

      expect(fs.statSync(filePath).ino).not.toBe(inodeBefore);
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("recreates the directory when it was removed after construction", async () => {
      const sut = new JsonFileBackend(dir);
      fs.rmSync(dir, { recursive: true, force: true });

      await sut.write({ a: 1 }, keys("a"));

      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("writes through a temporary file of its own with exclusive creation", async () => {
      const open = jest.spyOn(fs.promises, "open");
      const sut = new JsonFileBackend(dir);

      await sut.write({ a: 1 }, keys("a"));
      await sut.write({ a: 2 }, keys("a"));

      const tempOpens = open.mock.calls.filter(([, flags]) => flags === "wx");
      expect(tempOpens).toHaveLength(2);
      expect(tempOpens[0][0]).not.toBe(tempOpens[1][0]);
      expect(String(tempOpens[0][0])).toContain(`data.json.${process.pid}.`);
    });

    it("writes in place, synced to disk, before returning inside the Snap", () => {
      (isSnapStore as jest.Mock).mockReturnValue(true);
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;
      const fsyncSync = jest.spyOn(fs, "fsyncSync");

      const written = sut.write({ a: 2 }, keys("a"));

      expect(fs.statSync(filePath).ino).toBe(inodeBefore);
      expect(sut.read()).toEqual({ a: 2 });
      expect(fsyncSync).toHaveBeenCalledTimes(1);
      return written;
    });

    it("writes in place, synced to disk, when the rename fails with EXDEV", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;
      jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw errno("EXDEV");
      });
      const fsyncSync = jest.spyOn(fs, "fsyncSync");
      const sync = jest.spyOn(await fileHandlePrototype(dir), "sync");

      await sut.write({ a: 2 }, keys("a"));

      expect(fs.statSync(filePath).ino).toBe(inodeBefore);
      expect(sut.read()).toEqual({ a: 2 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
      // Once for the temporary file, once for the file written in place.
      expect(sync).toHaveBeenCalledTimes(1);
      expect(fsyncSync).toHaveBeenCalledTimes(1);
    });

    it("retries the rename while another process holds the file, without blocking", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;
      const renameSync = jest.spyOn(fs, "renameSync");
      renameSync
        .mockImplementationOnce(() => {
          throw errno("EPERM");
        })
        .mockImplementationOnce(() => {
          throw errno("EBUSY");
        });
      const wait = jest.spyOn(Atomics, "wait");
      const timeouts = immediateTimeouts();

      await sut.write({ a: 2 }, keys("a"));

      expect(renameSync).toHaveBeenCalledTimes(3);
      expect(timeouts.mock.calls.map((call) => call[1])).toEqual([10, 20]);
      expect(wait).not.toHaveBeenCalled();
      expect(fs.statSync(filePath).ino).not.toBe(inodeBefore);
      expect(sut.read()).toEqual({ a: 2 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("gives up the rename after about a second of retries and keeps the previous file", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1 }, keys("a"));
      const renameSync = jest.spyOn(fs, "renameSync").mockImplementation(() => {
        throw errno("EACCES");
      });
      const timeouts = immediateTimeouts();

      await expect(sut.write({ a: 2 }, keys("a"))).rejects.toEqual(
        expect.objectContaining({ code: "EACCES" }),
      );

      expect(renameSync).toHaveBeenCalledTimes(8);
      expect(timeouts.mock.calls.map((call) => call[1])).toEqual([10, 20, 40, 80, 160, 320, 370]);
      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("does not retry a rename that fails for another reason", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1 }, keys("a"));
      const renameSync = jest.spyOn(fs, "renameSync").mockImplementation(() => {
        throw errno("ENOENT");
      });
      const timeouts = immediateTimeouts();

      await expect(sut.write({ a: 2 }, keys("a"))).rejects.toEqual(
        expect.objectContaining({ code: "ENOENT" }),
      );

      expect(renameSync).toHaveBeenCalledTimes(1);
      expect(timeouts).not.toHaveBeenCalled();
      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("removes nothing when the temporary file could not be created", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1 }, keys("a"));
      jest.spyOn(fs.promises, "open").mockRejectedValueOnce(errno("EEXIST"));
      const rm = jest.spyOn(fs.promises, "rm");

      await expect(sut.write({ a: 2 }, keys("a"))).rejects.toEqual(
        expect.objectContaining({ code: "EEXIST" }),
      );

      expect(rm).not.toHaveBeenCalled();
      expect(sut.read()).toEqual({ a: 1 });
    });

    it("keeps the previous file when the write fails", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 1 }, keys("a"));
      jest.spyOn(await fileHandlePrototype(dir), "sync").mockRejectedValueOnce(errno("ENOSPC"));

      await expect(sut.write({ a: 2 }, keys("a"))).rejects.toEqual(
        expect.objectContaining({ code: "ENOSPC" }),
      );

      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("keeps writing after a failed write", async () => {
      const sut = new JsonFileBackend(dir);
      jest.spyOn(await fileHandlePrototype(dir), "sync").mockRejectedValueOnce(errno("ENOSPC"));
      await expect(sut.write({ a: 1 }, keys("a"))).rejects.toEqual(
        expect.objectContaining({ code: "ENOSPC" }),
      );

      await sut.write({ a: 2 }, keys("a"));

      expect(sut.read()).toEqual({ a: 2 });
    });

    it("rejects a serialization failure instead of throwing before it returns", async () => {
      const sut = new JsonFileBackend(dir);

      await expect(sut.write({ a: BigInt(1) }, keys("a"))).rejects.toThrow(TypeError);

      await sut.write({ a: 2 }, keys("a"));
      expect(sut.read()).toEqual({ a: 2 });
    });

    it("serializes before returning, so the caller may change the store right away", async () => {
      const sut = new JsonFileBackend(dir);
      const store: Store = { a: 1 };

      const written = sut.write(store, keys("a"));
      store.a = 2;
      await written;

      expect(sut.read()).toEqual({ a: 1 });
    });

    it("runs writes one after the other, in order", async () => {
      const sut = new JsonFileBackend(dir);

      const first = sut.write({ a: 1 }, keys("a"));
      const second = sut.write({ a: 2 }, keys("a"));
      const third = sut.write({ a: 3 }, keys("a"));
      await Promise.all([first, second, third]);

      expect(sut.read()).toEqual({ a: 3 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("does not touch the temporary file of a write from another instance", async () => {
      const first = new JsonFileBackend(dir);
      const second = new JsonFileBackend(dir);
      // The first write is caught before its rename, the way a second app instance's write would be.
      jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {});
      await first.write({ a: "first" }, keys("a"));
      const [tempName] = fs.readdirSync(dir);
      const tempPath = path.join(dir, tempName);

      await second.write({ a: "second" }, keys("a"));

      expect(fs.readdirSync(dir).sort()).toEqual(["data.json", tempName].sort());
      expect(JSON.parse(fs.readFileSync(tempPath, "utf8"))).toEqual({ a: "first" });
      expect(second.read()).toEqual({ a: "second" });
    });

    it("ignores a chmod the filesystem does not support", async () => {
      jest.spyOn(await fileHandlePrototype(dir), "chmod").mockRejectedValueOnce(errno("ENOSYS"));
      const sut = new JsonFileBackend(dir);

      await sut.write({ a: 1 }, keys("a"));

      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });
  });

  describe("writeSync during a background write", () => {
    it("replaces the file, and the background write leaves it alone when it completes", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 0 }, keys("a"));
      const proto = await fileHandlePrototype(dir);
      const sync = proto.sync;
      let reachedSync!: () => void;
      const syncReached = new Promise<void>((resolve) => (reachedSync = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      jest.spyOn(proto, "sync").mockImplementationOnce(async function (
        this: fs.promises.FileHandle,
      ) {
        reachedSync();
        await released;
        return sync.call(this);
      });
      const background = sut.write({ a: "background" }, keys("a"));
      await syncReached;
      expect(fs.readdirSync(dir)).toHaveLength(2);

      sut.writeSync({ a: "sync" }, keys("a"));

      expect(sut.read()).toEqual({ a: "sync" });
      // Removed by writeSync, so nothing is left if the app exits now.
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
      const inode = fs.statSync(filePath).ino;

      release();
      await background;

      expect(sut.read()).toEqual({ a: "sync" });
      expect(fs.statSync(filePath).ino).toBe(inode);
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("replaces the file while the background write waits to retry its rename", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 0 }, keys("a"));
      const renameSync = jest.spyOn(fs, "renameSync");
      renameSync.mockImplementationOnce(() => {
        throw errno("EBUSY");
      });
      const realSetTimeout = setTimeout;
      let retry!: () => void;
      let renameWaits!: () => void;
      const renameWaiting = new Promise<void>((resolve) => (renameWaits = resolve));
      jest.spyOn(global, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
        if (ms !== 10) {
          return realSetTimeout(callback, ms);
        }
        retry = callback;
        renameWaits();
        return 0;
      }) as unknown as typeof setTimeout);
      const background = sut.write({ a: "background" }, keys("a"));
      await renameWaiting;
      expect(renameSync).toHaveBeenCalledTimes(1);

      sut.writeSync({ a: "sync" }, keys("a"));
      retry();
      await background;

      expect(sut.read()).toEqual({ a: "sync" });
      expect(renameSync).toHaveBeenCalledTimes(2);
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("does not create a temporary file when writeSync supersedes target preparation", async () => {
      const sut = new JsonFileBackend(dir);
      await sut.write({ a: 0 }, keys("a"));
      let releasePreparation!: () => void;
      const preparationReleased = new Promise<void>((resolve) => (releasePreparation = resolve));
      let targetPreparationReached!: () => void;
      const targetPreparationReachedPromise = new Promise<void>(
        (resolve) => (targetPreparationReached = resolve),
      );
      jest.spyOn(fs.promises, "mkdir").mockImplementationOnce(async () => {
        targetPreparationReached();
        await preparationReleased;
        return undefined;
      });
      const open = jest.spyOn(fs.promises, "open");

      const background = sut.write({ a: "background" }, keys("a"));
      await targetPreparationReachedPromise;
      sut.writeSync({ a: "sync" }, keys("a"));
      releasePreparation();
      await expect(background).resolves.toBeUndefined();

      expect(open).not.toHaveBeenCalled();
      expect(sut.read()).toEqual({ a: "sync" });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("lets a background write that completed earlier be replaced as usual", async () => {
      const sut = new JsonFileBackend(dir);

      await sut.write({ a: "background" }, keys("a"));
      sut.writeSync({ a: "sync" }, keys("a"));

      expect(sut.read()).toEqual({ a: "sync" });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });
  });

  describe("writeSync", () => {
    it("writes the store before returning", () => {
      const store = { a: 1, b: { c: ["d"] } };
      const sut = new JsonFileBackend(dir);

      sut.writeSync(store, all(store));

      expect(fs.readFileSync(filePath, "utf8")).toBe(expected(store));
      expect(sut.read()).toEqual(store);
    });

    it("replaces the file without leaving temporary files behind", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;

      sut.writeSync({ a: 2 }, keys("a"));

      expect(fs.statSync(filePath).ino).not.toBe(inodeBefore);
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("recreates the directory when it was removed after construction", () => {
      const sut = new JsonFileBackend(dir);
      fs.rmSync(dir, { recursive: true, force: true });

      sut.writeSync({ a: 1 }, keys("a"));

      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("writes in place inside the Snap", () => {
      (isSnapStore as jest.Mock).mockReturnValue(true);
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;

      sut.writeSync({ a: 2 }, keys("a"));

      expect(fs.statSync(filePath).ino).toBe(inodeBefore);
      expect(sut.read()).toEqual({ a: 2 });
    });

    it("writes in place, synced to disk, when the rename fails with EXDEV", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;
      jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw errno("EXDEV");
      });
      const fsyncSync = jest.spyOn(fs, "fsyncSync");

      sut.writeSync({ a: 2 }, keys("a"));

      expect(fs.statSync(filePath).ino).toBe(inodeBefore);
      expect(sut.read()).toEqual({ a: 2 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
      // Once for the temporary file, once for the file written in place.
      expect(fsyncSync).toHaveBeenCalledTimes(2);
    });

    it("retries the rename while another process holds the file", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      const inodeBefore = fs.statSync(filePath).ino;
      const renameSync = jest.spyOn(fs, "renameSync");
      renameSync
        .mockImplementationOnce(() => {
          throw errno("EPERM");
        })
        .mockImplementationOnce(() => {
          throw errno("EBUSY");
        });
      const wait = jest.spyOn(Atomics, "wait").mockReturnValue("timed-out");

      sut.writeSync({ a: 2 }, keys("a"));

      expect(renameSync).toHaveBeenCalledTimes(3);
      expect(wait.mock.calls.map((call) => call[3])).toEqual([10, 20]);
      expect(fs.statSync(filePath).ino).not.toBe(inodeBefore);
      expect(sut.read()).toEqual({ a: 2 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("gives up the rename after about a second of retries and keeps the previous file", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      const renameSync = jest.spyOn(fs, "renameSync").mockImplementation(() => {
        throw errno("EACCES");
      });
      const wait = jest.spyOn(Atomics, "wait").mockReturnValue("timed-out");

      expect(() => sut.writeSync({ a: 2 }, keys("a"))).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );

      expect(renameSync).toHaveBeenCalledTimes(8);
      expect(wait.mock.calls.map((call) => call[3])).toEqual([10, 20, 40, 80, 160, 320, 370]);
      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("does not retry a rename that fails for another reason", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      const renameSync = jest.spyOn(fs, "renameSync").mockImplementation(() => {
        throw errno("ENOENT");
      });
      const wait = jest.spyOn(Atomics, "wait");

      expect(() => sut.writeSync({ a: 2 }, keys("a"))).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );

      expect(renameSync).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
      expect(sut.read()).toEqual({ a: 1 });
    });

    it("reports the failed rename when the temporary file cannot be removed either", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      jest.spyOn(fs, "renameSync").mockImplementation(() => {
        throw errno("EPERM");
      });
      jest.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      jest.spyOn(fs, "rmSync").mockImplementation(() => {
        throw errno("EBUSY");
      });

      expect(() => sut.writeSync({ a: 2 }, keys("a"))).toThrow(
        expect.objectContaining({ code: "EPERM" }),
      );
      expect(sut.read()).toEqual({ a: 1 });
    });

    it("removes nothing when the temporary file could not be created", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      jest.spyOn(fs, "openSync").mockImplementationOnce(() => {
        throw errno("EEXIST");
      });
      const rmSync = jest.spyOn(fs, "rmSync");

      expect(() => sut.writeSync({ a: 2 }, keys("a"))).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );

      expect(rmSync).not.toHaveBeenCalled();
      expect(sut.read()).toEqual({ a: 1 });
    });

    it("keeps the previous file when a write fails", () => {
      const sut = new JsonFileBackend(dir);
      sut.writeSync({ a: 1 }, keys("a"));
      jest.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
        throw errno("ENOSPC");
      });

      expect(() => sut.writeSync({ a: 2 }, keys("a"))).toThrow(
        expect.objectContaining({ code: "ENOSPC" }),
      );
      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });

    it("writes through the temporary file with exclusive creation", () => {
      const openSync = jest.spyOn(fs, "openSync");
      const sut = new JsonFileBackend(dir);

      sut.writeSync({ a: 1 }, keys("a"));
      sut.writeSync({ a: 2 }, keys("a"));

      const tempOpens = openSync.mock.calls.filter(([, flags]) => flags === "wx");
      expect(tempOpens).toHaveLength(2);
      expect(tempOpens[0][0]).not.toBe(tempOpens[1][0]);
    });

    it("ignores a chmod the filesystem does not support", () => {
      jest.spyOn(fs, "fchmodSync").mockImplementation(() => {
        throw errno("ENOSYS");
      });
      const sut = new JsonFileBackend(dir);

      sut.writeSync({ a: 1 }, keys("a"));

      expect(sut.read()).toEqual({ a: 1 });
      expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    });
  });

  if (process.platform !== "win32") {
    describe.each([
      ["write", (sut: JsonFileBackend, store: Store) => sut.write(store, all(store))],
      [
        "writeSync",
        (sut: JsonFileBackend, store: Store) => Promise.resolve(sut.writeSync(store, all(store))),
      ],
    ])("%s on a POSIX filesystem", (_, write) => {
      it("keeps the file readable by its owner only", async () => {
        fs.writeFileSync(filePath, "{}", { mode: 0o644 });
        const sut = new JsonFileBackend(dir);

        await write(sut, { secret: "value" });

        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      });

      it("makes the file readable by everyone in the Windows portable build", async () => {
        (isWindowsPortable as jest.Mock).mockReturnValue(true);
        const sut = new JsonFileBackend(dir);

        await write(sut, { a: 1 });

        expect(fs.statSync(filePath).mode & 0o777).toBe(0o666);
      });

      it("writes through a symlink to where it points", async () => {
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-backend-target-"));
        const targetPath = path.join(elsewhere, "real.json");
        try {
          fs.writeFileSync(targetPath, JSON.stringify({ a: 1 }));
          fs.symlinkSync(targetPath, filePath);
          const sut = new JsonFileBackend(dir);

          await write(sut, { a: 2 });

          expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
          expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({ a: 2 });
          expect(fs.readdirSync(dir)).toEqual(["data.json"]);
          expect(fs.readdirSync(elsewhere)).toEqual(["real.json"]);
        } finally {
          fs.rmSync(elsewhere, { recursive: true, force: true });
        }
      });

      it("creates the file a symlink points to when it does not exist yet", async () => {
        const targetPath = path.join(dir, "store", "real.json");
        fs.symlinkSync(targetPath, filePath);
        const sut = new JsonFileBackend(dir);

        await write(sut, { a: 1 });

        expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
        expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({ a: 1 });
        expect(sut.read()).toEqual({ a: 1 });
      });
    });
  }
});
