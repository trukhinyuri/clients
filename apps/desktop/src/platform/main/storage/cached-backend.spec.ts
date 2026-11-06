import { CachedBackend } from "./cached-backend";
import { StoreFile } from "./storage-backend";

type Store = Record<string, unknown>;

interface MockFile extends StoreFile {
  read: jest.Mock<Store, []>;
  write: jest.Mock<Promise<void>, [Readonly<Store>, ReadonlySet<string>]>;
  writeSync: jest.Mock<void, [Readonly<Store>, ReadonlySet<string>]>;
  /** What the file holds now. */
  stored(): Store;
}

function createMockFile(initial: Store = {}): MockFile {
  let data = { ...initial };
  return {
    read: jest.fn(() => ({ ...data })),
    write: jest.fn<Promise<void>, [Readonly<Store>, ReadonlySet<string>]>((store) => {
      data = { ...store };
      return Promise.resolve();
    }),
    writeSync: jest.fn<void, [Readonly<Store>, ReadonlySet<string>]>((store) => {
      data = { ...store };
    }),
    stored: () => data,
  };
}

function keys(...names: string[]): Set<string> {
  return new Set(names);
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/** A write that completes when the test says so. */
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CachedBackend", () => {
  let file: MockFile;
  let onWriteError: jest.Mock<void, [unknown]>;
  let sut: CachedBackend;

  beforeEach(() => {
    jest.useFakeTimers();
    file = createMockFile({ key1: "value1" });
    onWriteError = jest.fn();
    sut = new CachedBackend(file, onWriteError);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("read", () => {
    it("should load data from the file during construction", () => {
      expect(file.read).toHaveBeenCalledTimes(1);
      expect(sut.read()).toEqual({ key1: "value1" });
    });

    it("should return cached data on subsequent reads without reading the file again", () => {
      sut.read();
      sut.read();
      sut.read();

      expect(file.read).toHaveBeenCalledTimes(1);
    });

    it("should return updated data immediately without waiting for the write", () => {
      sut.set("key1", "updated");

      expect(sut.read()).toEqual({ key1: "updated" });
      expect(file.write).not.toHaveBeenCalled();
    });
  });

  describe("set", () => {
    it("should write to the file after the debounce delay", async () => {
      sut.set("key1", "updated");

      expect(file.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(200);

      expect(file.write).toHaveBeenCalledTimes(1);
      expect(file.write).toHaveBeenCalledWith({ key1: "updated" }, keys("key1"));
    });

    it("should coalesce rapid changes into a single write", async () => {
      sut.set("key1", "first");
      await jest.advanceTimersByTimeAsync(100);

      sut.set("key1", "second");
      await jest.advanceTimersByTimeAsync(100);

      sut.set("key2", "third");
      await jest.advanceTimersByTimeAsync(200);

      expect(file.write).toHaveBeenCalledTimes(1);
      expect(file.write).toHaveBeenCalledWith(
        { key1: "second", key2: "third" },
        keys("key1", "key2"),
      );
    });

    it("should write after the max wait even with continuous changes", async () => {
      for (let i = 0; i < 50; i++) {
        sut.set("iteration", i);
        await jest.advanceTimersByTimeAsync(150);
      }

      expect(file.write.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("should reset the debounce cycle after a write", async () => {
      sut.set("batch", 1);
      await jest.advanceTimersByTimeAsync(200);

      expect(file.write).toHaveBeenCalledTimes(1);

      sut.set("batch", 2);
      await jest.advanceTimersByTimeAsync(200);

      expect(file.write).toHaveBeenCalledTimes(2);
    });

    it("should pass only the keys changed since the previous write", async () => {
      sut.set("a", 1);
      sut.set("b", 2);
      await jest.advanceTimersByTimeAsync(200);
      sut.set("b", 3);
      await jest.advanceTimersByTimeAsync(200);

      expect(file.write).toHaveBeenNthCalledWith(1, { key1: "value1", a: 1, b: 2 }, keys("a", "b"));
      expect(file.write).toHaveBeenNthCalledWith(2, { key1: "value1", a: 1, b: 3 }, keys("b"));
    });

    it("should pass a key again when the same object is set after being modified", async () => {
      const value = { count: 1 };
      sut.set("obj", value);
      await jest.advanceTimersByTimeAsync(200);

      value.count = 2;
      sut.set("obj", value);
      await jest.advanceTimersByTimeAsync(200);

      expect(file.write).toHaveBeenNthCalledWith(
        2,
        { key1: "value1", obj: { count: 2 } },
        keys("obj"),
      );
    });

    it("should apply sequential changes correctly", () => {
      sut.set("a", 1);
      sut.set("b", 2);

      expect(sut.read().a).toBe(1);
      expect(sut.read().b).toBe(2);
    });

    it("should not change a store that was read before", () => {
      const before = sut.read();

      sut.set("key1", "changed");

      expect(before).toEqual({ key1: "value1" });
    });
  });

  describe("remove", () => {
    it("should remove the key and write it as changed", async () => {
      sut.remove("key1");

      expect(sut.read()).toEqual({});

      await jest.advanceTimersByTimeAsync(200);

      expect(file.write).toHaveBeenCalledWith({}, keys("key1"));
    });

    it("should write nothing for a key the store does not hold", async () => {
      sut.remove("missing");

      await jest.advanceTimersByTimeAsync(5000);

      expect(file.write).not.toHaveBeenCalled();
    });
  });

  describe("a write in flight", () => {
    let first: Deferred;

    beforeEach(() => {
      first = deferred();
      file.write.mockReturnValueOnce(first.promise);
    });

    it("should run one write at a time and write later changes after it", async () => {
      sut.set("a", 1);
      await jest.advanceTimersByTimeAsync(200);
      expect(file.write).toHaveBeenCalledTimes(1);

      sut.set("b", 2);
      await jest.advanceTimersByTimeAsync(5000);
      expect(file.write).toHaveBeenCalledTimes(1);

      first.resolve();
      await jest.advanceTimersByTimeAsync(0);

      expect(file.write).toHaveBeenCalledTimes(2);
      expect(file.write).toHaveBeenLastCalledWith({ key1: "value1", a: 1, b: 2 }, keys("b"));
    });

    it("should write nothing more when nothing changed while it ran", async () => {
      sut.set("a", 1);
      await jest.advanceTimersByTimeAsync(200);

      first.resolve();
      await jest.advanceTimersByTimeAsync(5000);

      expect(file.write).toHaveBeenCalledTimes(1);
    });

    it("should report a failed write and retry its changes on the next debounce", async () => {
      const error = new Error("ENOSPC");
      sut.set("a", 1);
      await jest.advanceTimersByTimeAsync(200);

      first.reject(error);
      await jest.advanceTimersByTimeAsync(200);

      expect(onWriteError).toHaveBeenCalledWith(error);
      expect(file.write).toHaveBeenCalledTimes(2);
      expect(file.write).toHaveBeenLastCalledWith({ key1: "value1", a: 1 }, keys("a"));
    });

    it("should report a synchronously thrown write and retry it without throwing from the timer", async () => {
      const error = new Error("serialize");
      file.write.mockReset();
      file.write.mockImplementationOnce(() => {
        throw error;
      });
      file.write.mockResolvedValue(undefined);
      sut.set("a", 1);

      await jest.advanceTimersByTimeAsync(200);

      expect(onWriteError).toHaveBeenCalledWith(error);
      await jest.advanceTimersByTimeAsync(200);
      expect(file.write).toHaveBeenCalledTimes(2);
    });

    it("does not retry or log a rejected write superseded by flush", async () => {
      const error = new Error("ENOSPC");
      sut.set("a", 1);
      await jest.advanceTimersByTimeAsync(200);

      sut.flush();
      first.reject(error);
      await jest.advanceTimersByTimeAsync(5000);

      expect(file.writeSync).toHaveBeenCalledWith({ key1: "value1", a: 1 }, keys());
      expect(onWriteError).not.toHaveBeenCalled();
      expect(file.write).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("restores the max-wait bound when it fired during a failed write", async () => {
      sut.set("a", 1);
      await jest.advanceTimersByTimeAsync(200);
      sut.set("b", 2);
      await jest.advanceTimersByTimeAsync(5000);

      first.reject(new Error("ENOSPC"));
      await jest.advanceTimersByTimeAsync(0);

      expect(jest.getTimerCount()).toBe(2);
    });

    it("should flush the changes a failed write held", async () => {
      sut.set("a", 1);
      await jest.advanceTimersByTimeAsync(200);
      first.reject(new Error("ENOSPC"));
      await jest.advanceTimersByTimeAsync(0);

      sut.flush();

      expect(file.writeSync).toHaveBeenCalledWith({ key1: "value1", a: 1 }, keys("a"));
    });
  });

  describe("flush", () => {
    it("should write pending changes before returning", () => {
      sut.set("key1", "pending");

      expect(file.write).not.toHaveBeenCalled();

      sut.flush();

      expect(file.writeSync).toHaveBeenCalledTimes(1);
      expect(file.writeSync).toHaveBeenCalledWith({ key1: "pending" }, keys("key1"));
      expect(file.stored()).toEqual({ key1: "pending" });
    });

    it("should write the cached store without reading the file again", () => {
      sut.set("key1", "pending");
      sut.flush();

      expect(file.read).toHaveBeenCalledTimes(1);
    });

    it("should be a no-op when there are no pending changes", () => {
      sut.flush();

      expect(file.writeSync).not.toHaveBeenCalled();
    });

    it("should only write once when flush is called twice sequentially", () => {
      sut.set("key1", "value");
      sut.flush();
      sut.flush();

      expect(file.writeSync).toHaveBeenCalledTimes(1);
    });

    it("should not write again if the debounce timer fires after an explicit flush", async () => {
      sut.set("key1", "value");
      sut.flush();

      await jest.advanceTimersByTimeAsync(5000);

      expect(file.writeSync).toHaveBeenCalledTimes(1);
      expect(file.write).not.toHaveBeenCalled();
    });

    it("should write before returning while a background write is in flight", async () => {
      const inFlight = deferred();
      file.write.mockReturnValueOnce(inFlight.promise);
      sut.set("a", 1);
      await jest.advanceTimersByTimeAsync(200);

      sut.flush();

      expect(file.writeSync).toHaveBeenCalledWith({ key1: "value1", a: 1 }, keys());

      inFlight.resolve();
      await jest.advanceTimersByTimeAsync(5000);

      expect(file.write).toHaveBeenCalledTimes(1);
      expect(file.writeSync).toHaveBeenCalledTimes(1);
    });

    it("should keep the changes when the write fails, and write them with the next flush", () => {
      sut.set("key1", "value");
      file.writeSync.mockImplementationOnce(() => {
        throw new Error("ENOSPC");
      });

      expect(() => sut.flush()).toThrow("ENOSPC");

      sut.flush();

      expect(file.writeSync).toHaveBeenCalledTimes(2);
      expect(file.writeSync).toHaveBeenLastCalledWith({ key1: "value" }, keys("key1"));
    });
  });
});
