import { CachedBackend } from "./cached-backend";
import { StorageBackend } from "./storage-backend";

function createMockBackend(initial: Record<string, unknown> = {}): StorageBackend {
  let data = { ...initial };
  return {
    read: jest.fn(() => ({ ...data })),
    update: jest.fn((updater: (store: Record<string, unknown>) => Record<string, unknown>) => {
      data = updater(data);
    }),
    write: jest.fn((store: Record<string, unknown>) => {
      data = store;
    }),
    flush: jest.fn(() => {}),
  };
}

describe("CachedBackend", () => {
  let inner: StorageBackend;
  let sut: CachedBackend;

  beforeEach(() => {
    jest.useFakeTimers();
    inner = createMockBackend({ key1: "value1" });
    sut = new CachedBackend(inner);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("read", () => {
    it("should load data from inner backend during construction", () => {
      expect(inner.read).toHaveBeenCalledTimes(1);
      expect(sut.read()).toEqual({ key1: "value1" });
    });

    it("should return cached data on subsequent reads without calling inner backend again", () => {
      sut.read();
      sut.read();
      sut.read();

      expect(inner.read).toHaveBeenCalledTimes(1);
    });

    it("should return updated data immediately without waiting for flush", () => {
      sut.update((store) => ({ ...store, key1: "updated" }));

      expect(sut.read()).toEqual({ key1: "updated" });
      expect(inner.write).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("should flush to inner backend after debounce delay", async () => {
      sut.update((store) => ({ ...store, key1: "updated" }));

      expect(inner.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(200);

      expect(inner.write).toHaveBeenCalledTimes(1);
    });

    it("should coalesce rapid updates into a single flush", async () => {
      sut.update((store) => ({ ...store, key1: "first" }));
      await jest.advanceTimersByTimeAsync(100);

      sut.update((store) => ({ ...store, key1: "second" }));
      await jest.advanceTimersByTimeAsync(100);

      sut.update((store) => ({ ...store, key1: "third" }));
      await jest.advanceTimersByTimeAsync(200);

      expect(inner.write).toHaveBeenCalledTimes(1);
      expect(inner.write).toHaveBeenCalledWith({ key1: "third" });
    });

    it("should flush after max wait even with continuous updates", async () => {
      for (let i = 0; i < 50; i++) {
        sut.update((store) => ({ ...store, iteration: i }));
        await jest.advanceTimersByTimeAsync(150);
      }

      expect((inner.write as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("should reset debounce cycle after flush", async () => {
      sut.update(() => ({ batch: 1 }));
      await jest.advanceTimersByTimeAsync(200);

      expect(inner.write).toHaveBeenCalledTimes(1);

      sut.update(() => ({ batch: 2 }));
      await jest.advanceTimersByTimeAsync(200);

      expect(inner.write).toHaveBeenCalledTimes(2);
    });

    it("should apply sequential updates correctly", () => {
      sut.update((store) => ({ ...store, a: 1 }));
      sut.update((store) => ({ ...store, b: 2 }));

      expect(sut.read().a).toBe(1);
      expect(sut.read().b).toBe(2);
    });
  });

  describe("write", () => {
    it("should replace the cached store and flush it after the debounce delay", async () => {
      sut.write({ other: "value" });

      expect(sut.read()).toEqual({ other: "value" });
      expect(inner.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(200);

      expect(inner.write).toHaveBeenCalledWith({ other: "value" });
    });

    it("should not keep a reference to the object it was given", () => {
      const store: Record<string, unknown> = { key1: "value" };
      sut.write(store);

      store.key1 = "changed";

      expect(sut.read()).toEqual({ key1: "value" });
    });
  });

  describe("flush", () => {
    it("should immediately persist pending data to inner backend", () => {
      sut.update((store) => ({ ...store, key1: "pending" }));

      expect(inner.write).not.toHaveBeenCalled();

      sut.flush();

      expect(inner.write).toHaveBeenCalledTimes(1);
      expect(inner.write).toHaveBeenCalledWith({ key1: "pending" });
    });

    it("should write the cached store without reading the inner backend again", () => {
      sut.update((store) => ({ ...store, key1: "pending" }));
      sut.flush();

      expect(inner.read).toHaveBeenCalledTimes(1);
      expect(inner.update).not.toHaveBeenCalled();
    });

    it("should be a no-op when there are no pending changes", () => {
      sut.flush();

      expect(inner.write).not.toHaveBeenCalled();
    });

    it("should only write once when flush is called twice sequentially", () => {
      sut.update((store) => ({ ...store, key1: "value" }));
      sut.flush();
      sut.flush();

      expect(inner.write).toHaveBeenCalledTimes(1);
    });

    it("should not double-flush if debounce timer fires after explicit flush", async () => {
      sut.update((store) => ({ ...store, key1: "value" }));
      sut.flush();

      await jest.advanceTimersByTimeAsync(5000);

      expect(inner.write).toHaveBeenCalledTimes(1);
    });
  });
});
