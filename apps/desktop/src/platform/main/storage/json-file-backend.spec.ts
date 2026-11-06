import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isSnapStore, isWindowsPortable } from "../../../main/platform-utils.main";

import { JsonFileBackend } from "./json-file-backend";

jest.mock("../../../main/platform-utils.main", () => ({
  isSnapStore: jest.fn(() => false),
  isWindowsPortable: jest.fn(() => false),
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
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

  it("writes the tab-indented JSON electron-store wrote, so older versions can read it", () => {
    const store = { a: 1, b: { c: ["d"] } };
    const sut = new JsonFileBackend(dir);

    sut.write(store);

    expect(fs.readFileSync(filePath, "utf8")).toBe(JSON.stringify(store, undefined, "\t"));
    expect(sut.read()).toEqual(store);
  });

  it("replaces the file without leaving temporary files behind", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    const inodeBefore = fs.statSync(filePath).ino;

    sut.write({ a: 2 });

    expect(fs.statSync(filePath).ino).not.toBe(inodeBefore);
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("recreates the directory when it was removed after construction", () => {
    const sut = new JsonFileBackend(dir);
    fs.rmSync(dir, { recursive: true, force: true });

    sut.write({ a: 1 });

    expect(sut.read()).toEqual({ a: 1 });
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("writes in place inside the Snap", () => {
    (isSnapStore as jest.Mock).mockReturnValue(true);
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    const inodeBefore = fs.statSync(filePath).ino;

    sut.write({ a: 2 });

    expect(fs.statSync(filePath).ino).toBe(inodeBefore);
    expect(sut.read()).toEqual({ a: 2 });
  });

  it("writes in place, synced to disk, when the rename fails with EXDEV", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    const inodeBefore = fs.statSync(filePath).ino;
    jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw errno("EXDEV");
    });
    const fsyncSync = jest.spyOn(fs, "fsyncSync");

    sut.write({ a: 2 });

    expect(fs.statSync(filePath).ino).toBe(inodeBefore);
    expect(sut.read()).toEqual({ a: 2 });
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    // Once for the temporary file, once for the file written in place.
    expect(fsyncSync).toHaveBeenCalledTimes(2);
  });

  it("retries the rename while another process holds the file", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
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

    sut.write({ a: 2 });

    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map((call) => call[3])).toEqual([10, 20]);
    expect(fs.statSync(filePath).ino).not.toBe(inodeBefore);
    expect(sut.read()).toEqual({ a: 2 });
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("gives up the rename after about a second of retries and keeps the previous file", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    const renameSync = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw errno("EACCES");
    });
    const wait = jest.spyOn(Atomics, "wait").mockReturnValue("timed-out");

    expect(() => sut.write({ a: 2 })).toThrow(expect.objectContaining({ code: "EACCES" }));

    expect(renameSync).toHaveBeenCalledTimes(8);
    expect(wait.mock.calls.map((call) => call[3])).toEqual([10, 20, 40, 80, 160, 320, 370]);
    expect(sut.read()).toEqual({ a: 1 });
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("does not retry a rename that fails for another reason", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    const renameSync = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw errno("ENOENT");
    });
    const wait = jest.spyOn(Atomics, "wait");

    expect(() => sut.write({ a: 2 })).toThrow(expect.objectContaining({ code: "ENOENT" }));

    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(sut.read()).toEqual({ a: 1 });
  });

  it("reports the failed rename when the temporary file cannot be removed either", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    jest.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    jest.spyOn(fs, "rmSync").mockImplementation(() => {
      throw errno("EBUSY");
    });

    expect(() => sut.write({ a: 2 })).toThrow(expect.objectContaining({ code: "EPERM" }));
    expect(sut.read()).toEqual({ a: 1 });
  });

  it("removes nothing when the temporary file could not be created", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    jest.spyOn(fs, "openSync").mockImplementationOnce(() => {
      throw errno("EEXIST");
    });
    const rmSync = jest.spyOn(fs, "rmSync");

    expect(() => sut.write({ a: 2 })).toThrow(expect.objectContaining({ code: "EEXIST" }));

    expect(rmSync).not.toHaveBeenCalled();
    expect(sut.read()).toEqual({ a: 1 });
  });

  it("keeps the previous file when a write fails", () => {
    const sut = new JsonFileBackend(dir);
    sut.write({ a: 1 });
    jest.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw errno("ENOSPC");
    });

    expect(() => sut.write({ a: 2 })).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(sut.read()).toEqual({ a: 1 });
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("does not touch the temporary file of a write from another instance", () => {
    const first = new JsonFileBackend(dir);
    const second = new JsonFileBackend(dir);
    // The first write is caught before its rename, the way a second app instance's write would be.
    jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {});
    first.write({ a: "first" });
    const [tempName] = fs.readdirSync(dir);
    const tempPath = path.join(dir, tempName);

    second.write({ a: "second" });

    expect(fs.readdirSync(dir).sort()).toEqual(["data.json", tempName].sort());
    expect(JSON.parse(fs.readFileSync(tempPath, "utf8"))).toEqual({ a: "first" });
    expect(second.read()).toEqual({ a: "second" });
  });

  it("writes through the temporary file with exclusive creation", () => {
    const openSync = jest.spyOn(fs, "openSync");
    const sut = new JsonFileBackend(dir);

    sut.write({ a: 1 });
    sut.write({ a: 2 });

    const tempOpens = openSync.mock.calls.filter(([, flags]) => flags === "wx");
    expect(tempOpens).toHaveLength(2);
    expect(tempOpens[0][0]).not.toBe(tempOpens[1][0]);
  });

  it("ignores a chmod the filesystem does not support", () => {
    jest.spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw errno("ENOSYS");
    });
    const sut = new JsonFileBackend(dir);

    sut.write({ a: 1 });

    expect(sut.read()).toEqual({ a: 1 });
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  if (process.platform !== "win32") {
    it("keeps the file readable by its owner only", () => {
      fs.writeFileSync(filePath, "{}", { mode: 0o644 });
      const sut = new JsonFileBackend(dir);

      sut.write({ secret: "value" });

      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    });

    it("makes the file readable by everyone in the Windows portable build", () => {
      (isWindowsPortable as jest.Mock).mockReturnValue(true);
      const sut = new JsonFileBackend(dir);

      sut.write({ a: 1 });

      expect(fs.statSync(filePath).mode & 0o777).toBe(0o666);
    });

    it("writes through a symlink to where it points", () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-backend-target-"));
      const targetPath = path.join(elsewhere, "real.json");
      try {
        fs.writeFileSync(targetPath, JSON.stringify({ a: 1 }));
        fs.symlinkSync(targetPath, filePath);
        const sut = new JsonFileBackend(dir);

        sut.write({ a: 2 });

        expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
        expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({ a: 2 });
        expect(fs.readdirSync(dir)).toEqual(["data.json"]);
        expect(fs.readdirSync(elsewhere)).toEqual(["real.json"]);
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("creates the file a symlink points to when it does not exist yet", () => {
      const targetPath = path.join(dir, "store", "real.json");
      fs.symlinkSync(targetPath, filePath);
      const sut = new JsonFileBackend(dir);

      sut.write({ a: 1 });

      expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({ a: 1 });
      expect(sut.read()).toEqual({ a: 1 });
    });
  }

  it("applies an update to what the file holds", () => {
    fs.writeFileSync(filePath, JSON.stringify({ a: 1 }));
    const sut = new JsonFileBackend(dir);

    sut.update((store) => ({ ...store, b: 2 }));

    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ a: 1, b: 2 });
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
