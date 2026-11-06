import * as fs from "fs";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import * as path from "path";

import { app, BrowserWindow, ipcMain, screen, session } from "electron";
import { mock, MockProxy } from "jest-mock-extended";
import { NEVER, of } from "rxjs";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { AbstractStorageService } from "@bitwarden/common/platform/abstractions/storage.service";
import { BiometricStateService } from "@bitwarden/key-management";

import { SafeShell } from "../platform/main/safe-shell.main";
import { DesktopSettingsService } from "../platform/services/desktop-settings.service";

// window.main.ts registers a privileged scheme at module load time, which
// requires the electron runtime. Mock the surface the module touches on
// import so it can be loaded in Jest.
jest.mock("electron", () => ({
  app: {},
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn() },
  nativeTheme: {},
  screen: {},
  session: {},
  protocol: { registerSchemesAsPrivileged: jest.fn() },
  net: {},
}));

// window.main.ts imports processisolations, which loads a native .node
// module at import time.
jest.mock("@bitwarden/desktop-napi", () => ({
  processisolations: {
    isolateProcess: jest.fn(),
    isCoreDumpingDisabled: jest.fn(),
    disableCoredumps: jest.fn(),
  },
}));

import { isSnapStore } from "./platform-utils.main";
import { isConfinedSnap, WindowMain } from "./window.main";

describe("WindowMain", () => {
  describe("isLocalBundleUrl", () => {
    let sut: WindowMain;
    // Access the private method under test without widening its visibility
    // in production code.
    let isLocalBundleUrl: (url: string) => boolean;

    // The `file:` branch accepts only the app's own bundle, derived from
    // __dirname the same way the production code does. __dirname here is
    // this spec's directory, which is also the directory the code under test
    // resolves against, so this is the real bundle URL for the running test.
    const bundleUrl = pathToFileURL(path.join(__dirname, "/index.html")).toString();

    beforeEach(() => {
      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        mock<DesktopSettingsService>(),
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );

      isLocalBundleUrl = (url: string) => (sut as any).isLocalBundleUrl(url);
    });

    it("returns true for the app's own file:// bundle URL", () => {
      expect(isLocalBundleUrl(bundleUrl)).toBe(true);
    });

    it("returns true for the app's own bundle URL with a hash", () => {
      expect(isLocalBundleUrl(`${bundleUrl}#/passkeys`)).toBe(true);
    });

    it("returns true for the app's own bundle URL with a query", () => {
      expect(isLocalBundleUrl(`${bundleUrl}?redirectUrl=/passkeys`)).toBe(true);
    });

    it("returns false for a file:// URL with a foreign host", () => {
      expect(isLocalBundleUrl("file://attacker.com/index.html")).toBe(false);
    });

    it("returns false for a file:// URL in a foreign directory", () => {
      expect(isLocalBundleUrl("file:///tmp/evil/index.html")).toBe(false);
    });

    it("returns false for a file:// URL that traverses outside the bundle dir", () => {
      // The `../` segments normalize (via the URL parser) to
      // /tmp/evil/index.html, outside the bundle.
      expect(isLocalBundleUrl(`${bundleUrl}/../../../tmp/evil/index.html`)).toBe(false);
    });

    it("returns true for a bw-desktop-file://bundle/index.html URL", () => {
      expect(isLocalBundleUrl("bw-desktop-file://bundle/index.html")).toBe(true);
    });

    it("returns false for an external https URL", () => {
      expect(isLocalBundleUrl("https://evil.com")).toBe(false);
    });

    it("returns false for a bw-desktop-file URL with the wrong host", () => {
      expect(isLocalBundleUrl("bw-desktop-file://evil/index.html")).toBe(false);
    });

    it("returns false for an unparseable string without throwing", () => {
      expect(isLocalBundleUrl("not a url")).toBe(false);
    });
  });

  describe("init", () => {
    let sut: WindowMain;
    let createWindow: jest.SpyInstance;

    beforeEach(() => {
      // Development mode skips process isolation, which is not under test here.
      (global as any).BIT_ENVIRONMENT = "development";

      // `on` never emits, so `ready` behaves as if it fired before `init()` was called.
      Object.assign(app, {
        requestSingleInstanceLock: jest.fn().mockReturnValue(true),
        on: jest.fn(),
        whenReady: jest.fn().mockResolvedValue(undefined),
      });
      Object.assign(session, {
        fromPartition: jest.fn().mockReturnValue({ clearCache: jest.fn() }),
      });

      const desktopSettingsService = mock<DesktopSettingsService>();
      Object.assign(desktopSettingsService, { modalMode$: NEVER, preventScreenshots$: NEVER });

      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        desktopSettingsService,
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );

      jest.spyOn(sut as any, "setupAppProtocol").mockImplementation(() => {});
      createWindow = jest.spyOn(sut, "createWindow").mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete (global as any).BIT_ENVIRONMENT;
      delete (global as any).setImmediate;
    });

    const setUpReload = async () => {
      await sut.init(true);
      // Reloads are skipped in development mode.
      (global as any).BIT_ENVIRONMENT = "production";
      // jsdom has no setImmediate, which the reload uses to yield a tick.
      (global as any).setImmediate = (fn: () => void) => setTimeout(fn, 0);
      jest.spyOn(sut, "getBackgroundColor").mockResolvedValue("#000000");
      (sut as any).enableRendererProcessForceCrashReload = true;

      return jest
        .mocked(ipcMain.on)
        .mock.calls.findLast(([channel]) => channel === "reload-process")[1] as () => Promise<void>;
    };

    it("creates the window when the ready event has already fired", async () => {
      await sut.init(true);

      expect(createWindow).toHaveBeenCalledWith("full-app", true);
    });

    describe("while the startup window is still being created", () => {
      let finishStartupWindow: () => void;
      let initDone: Promise<void>;

      const appHandler = (event: string) =>
        jest.mocked(app.on).mock.calls.find(([name]) => name === event)[1] as (
          ...args: unknown[]
        ) => Promise<void>;

      beforeEach(async () => {
        createWindow.mockReturnValueOnce(
          new Promise<void>((resolve) => (finishStartupWindow = resolve)),
        );
        initDone = sut.init(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(createWindow).toHaveBeenCalledTimes(1);
      });

      it("does not create a second window on activate", async () => {
        const activateDone = appHandler("activate")();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(createWindow).toHaveBeenCalledTimes(1);

        const win = mock<BrowserWindow>();
        sut.win = win;
        finishStartupWindow();
        await initDone;
        await activateDone;

        expect(createWindow).toHaveBeenCalledTimes(1);
        expect(win.show).toHaveBeenCalled();
      });

      it("focuses the startup window on second-instance", async () => {
        const secondInstanceDone = appHandler("second-instance")({}, [], "");

        const win = mock<BrowserWindow>();
        win.isDestroyed.mockReturnValue(false);
        sut.win = win;
        finishStartupWindow();
        await initDone;
        await secondInstanceDone;

        expect(win.focus).toHaveBeenCalled();
      });
    });

    it("leaves no crash listeners behind after a reload", async () => {
      const reloadProcess = await setUpReload();
      const webContents = Object.assign(new EventEmitter(), {
        forcefullyCrashRenderer: jest.fn(() => webContents.emit("render-process-gone")),
        reloadIgnoringCache: jest.fn(),
      });
      sut.win = {
        webContents,
        setBackgroundColor: jest.fn(),
        isDestroyed: () => false,
      } as any;

      await reloadProcess();
      await reloadProcess();

      expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(2);
      expect(webContents.listenerCount("render-process-gone")).toBe(0);
      expect(webContents.listenerCount("destroyed")).toBe(0);
      expect(webContents.listenerCount("error")).toBe(0);
    });

    it("finishes a reload when the window is destroyed during the renderer crash", async () => {
      const reloadProcess = await setUpReload();
      let destroyed = false;
      const webContents = Object.assign(new EventEmitter(), {
        forcefullyCrashRenderer: jest.fn(() => {
          destroyed = true;
          webContents.emit("destroyed");
        }),
        reloadIgnoringCache: jest.fn(),
      });
      sut.win = {
        webContents,
        setBackgroundColor: jest.fn(),
        isDestroyed: () => destroyed,
      } as any;

      await reloadProcess();

      expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled();

      // A stuck reload would skip this one as a duplicate.
      destroyed = false;
      await reloadProcess();

      expect(webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(2);
    });
  });

  describe("createWindow", () => {
    let sut: WindowMain;

    const fakeWindow = () =>
      Object.assign(new EventEmitter(), {
        webContents: {
          on: jest.fn(),
          send: jest.fn(),
          setWindowOpenHandler: jest.fn(),
          invalidate: jest.fn(),
          userAgent: "",
        },
        isDestroyed: jest.fn().mockReturnValue(false),
        isVisible: jest.fn().mockReturnValue(true),
        loadURL: jest.fn().mockResolvedValue(undefined),
        show: jest.fn(),
        setContentProtection: jest.fn(),
        setMinimumSize: jest.fn(),
        setResizable: jest.fn(),
        setAlwaysOnTop: jest.fn(),
      });

    beforeEach(() => {
      (global as any).BIT_ENVIRONMENT = "production";

      const desktopSettingsService = mock<DesktopSettingsService>();
      Object.assign(desktopSettingsService, {
        alwaysOnTop$: of(false),
        preventScreenshots$: of(false),
      });

      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        desktopSettingsService,
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );

      jest.spyOn(sut as any, "getWindowState").mockResolvedValue({});
      jest.spyOn(sut, "getBackgroundColor").mockResolvedValue("#000000");
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete (global as any).BIT_ENVIRONMENT;
    });

    it("keeps the newer window when an older window closes", async () => {
      const first = fakeWindow();
      const second = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => first as any);
      jest.mocked(BrowserWindow).mockImplementationOnce(() => second as any);

      await sut.createWindow();
      await sut.createWindow();
      first.emit("closed");

      expect(sut.win).toBe(second);
    });

    it("handles focus on the remaining window after another window closes", async () => {
      const first = fakeWindow();
      const second = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => first as any);
      jest.mocked(BrowserWindow).mockImplementationOnce(() => second as any);

      await sut.createWindow();
      await sut.createWindow();
      first.emit("closed");
      second.emit("focus");

      expect(second.webContents.send).toHaveBeenCalledWith("messagingService", {
        command: "windowIsFocused",
        windowIsFocused: true,
      });
    });

    it("clears the window reference when the current window closes", async () => {
      const win = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => win as any);

      await sut.createWindow();
      win.emit("closed");

      expect(sut.win).toBeNull();
    });

    describe("when the window is shown", () => {
      const originalPlatform = process.platform;
      let win: ReturnType<typeof fakeWindow>;

      const setPlatform = (platform: NodeJS.Platform) =>
        Object.defineProperty(process, "platform", { value: platform, configurable: true });

      beforeEach(async () => {
        win = fakeWindow();
        jest.mocked(BrowserWindow).mockImplementationOnce(() => win as any);
        await sut.createWindow();
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
        setPlatform(originalPlatform);
      });

      // bitwarden/clients#23899: a repaint unblocks Chromium's Wayland configure ack.
      it("repaints the window on Linux", () => {
        setPlatform("linux");

        win.emit("show");

        expect(win.webContents.invalidate).not.toHaveBeenCalled();
        jest.advanceTimersByTime(100);
        expect(win.webContents.invalidate).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1400);
        expect(win.webContents.invalidate).toHaveBeenCalledTimes(3);
      });

      it("does not repaint a window that was hidden or destroyed in the meantime", () => {
        setPlatform("linux");

        win.emit("show");
        win.isVisible.mockReturnValue(false);
        jest.advanceTimersByTime(100);
        win.isDestroyed.mockReturnValue(true);
        jest.advanceTimersByTime(1400);

        expect(win.webContents.invalidate).not.toHaveBeenCalled();
      });

      it.each<NodeJS.Platform>(["darwin", "win32"])("does not repaint on %s", (platform) => {
        setPlatform(platform);

        win.emit("show");
        jest.advanceTimersByTime(1500);

        expect(win.webContents.invalidate).not.toHaveBeenCalled();
      });
    });
  });

  describe("withWindow", () => {
    let sut: WindowMain;
    let desktopSettingsService: MockProxy<DesktopSettingsService>;

    beforeEach(() => {
      desktopSettingsService = mock<DesktopSettingsService>();
      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        desktopSettingsService,
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );
    });

    it("skips the callback when the window is destroyed", () => {
      const win = mock<BrowserWindow>();
      win.isDestroyed.mockReturnValue(true);
      sut.win = win;
      const fn = jest.fn();

      expect(sut.withWindow(fn)).toBeUndefined();
      expect(fn).not.toHaveBeenCalled();
    });

    it("skips toggling always on top when there is no window", async () => {
      sut.win = null;

      await sut.toggleAlwaysOnTop();

      expect(desktopSettingsService.setAlwaysOnTop).not.toHaveBeenCalled();
    });
  });

  describe("getWindowState", () => {
    const originalPlatform = process.platform;
    const defaultWidth = 1000;
    const defaultHeight = 700;

    // The two outputs from the issue, side by side; the smaller one is the primary.
    const firstDisplay = { x: 0, y: 0, width: 1920, height: 1280 };
    const largerDisplay = { x: 1920, y: 0, width: 3072, height: 1728 };

    let sut: WindowMain;
    let desktopSettingsService: MockProxy<DesktopSettingsService>;
    let ozonePlatform: string;

    const setPlatform = (platform: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    };

    const setDisplays = (...displays: Electron.Rectangle[]) => {
      const intersectionArea = (a: Electron.Rectangle, b: Electron.Rectangle) =>
        Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

      Object.assign(screen, {
        getAllDisplays: () => displays.map((bounds) => ({ bounds })),
        getPrimaryDisplay: () => ({ bounds: displays[0] }),
        getDisplayMatching: (rect: Electron.Rectangle) => ({
          bounds: displays.reduce((best, bounds) =>
            intersectionArea(bounds, rect) > intersectionArea(best, rect) ? bounds : best,
          ),
        }),
      });
    };

    const getWindowState = (savedState: object) => {
      Object.assign(desktopSettingsService, { window$: of(savedState) });
      return (sut as any).getWindowState(defaultWidth, defaultHeight);
    };

    beforeEach(() => {
      desktopSettingsService = mock<DesktopSettingsService>();
      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        desktopSettingsService,
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );

      setPlatform("linux");
      ozonePlatform = "x11";
      Object.assign(app, {
        commandLine: {
          getSwitchValue: (name: string) => (name === "ozone-platform" ? ozonePlatform : ""),
        },
      });
      setDisplays(firstDisplay, largerDisplay);
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    describe("on native Wayland", () => {
      beforeEach(() => {
        ozonePlatform = "wayland";
      });

      // Wayland does not tell the app where its window is, so the saved position is 0,0 and the
      // saved display is the first output, whichever output the window was used on.
      it("does not maximize a window used on an output larger than the first one", async () => {
        const state = await getWindowState({
          width: 2914,
          height: 1606,
          x: 0,
          y: 0,
          isMaximized: false,
          displayBounds: firstDisplay,
        });

        expect(state.isMaximized).toBe(false);
        expect(state.width).toBe(2914);
        expect(state.height).toBe(1606);
      });

      it("fits the width to the largest display rather than to the saved one", async () => {
        const state = await getWindowState({
          width: 4000,
          height: 1000,
          x: 0,
          y: 0,
          isMaximized: false,
          displayBounds: firstDisplay,
        });

        expect(state.isMaximized).toBe(false);
        expect(state.width).toBe(largerDisplay.width - 10);
        expect(state.height).toBe(1000);
      });

      it("keeps the size of a window that fits a display of another orientation", async () => {
        // Same area, so the largest display alone would pick the landscape primary.
        setDisplays(
          { x: 0, y: 0, width: 1920, height: 1080 },
          { x: 1920, y: 0, width: 1080, height: 1920 },
        );

        const state = await getWindowState({
          width: 1000,
          height: 1600,
          x: 0,
          y: 0,
          isMaximized: false,
          displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
        });

        expect(state.isMaximized).toBe(false);
        expect(state.width).toBe(1000);
        expect(state.height).toBe(1600);
      });

      it("clamps a window that is larger than every display instead of maximizing it", async () => {
        const state = await getWindowState({
          width: 4000,
          height: 2000,
          x: 0,
          y: 0,
          isMaximized: false,
          displayBounds: firstDisplay,
        });

        expect(state.isMaximized).toBe(false);
        expect(state.width).toBe(largerDisplay.width - 10);
        expect(state.height).toBe(largerDisplay.height - 10);
      });

      // The compositor can announce outputs after the app reads the display list at start.
      it("does not maximize when the output the window was used on is not known yet", async () => {
        setDisplays(firstDisplay);

        const state = await getWindowState({
          width: 2914,
          height: 1606,
          x: 0,
          y: 0,
          isMaximized: false,
          displayBounds: firstDisplay,
        });

        expect(state.isMaximized).toBe(false);
        expect(state.width).toBe(firstDisplay.width - 10);
        expect(state.height).toBe(firstDisplay.height - 10);
      });

      it("keeps a saved maximized state", async () => {
        const state = await getWindowState({
          width: 1000,
          height: 700,
          x: 0,
          y: 0,
          isMaximized: true,
          displayBounds: firstDisplay,
        });

        expect(state.isMaximized).toBe(true);
      });
    });

    describe("where the window position is known", () => {
      it("maximizes a window larger than the display it was on", async () => {
        const state = await getWindowState({
          width: 2914,
          height: 1606,
          x: 0,
          y: 0,
          isMaximized: false,
          displayBounds: firstDisplay,
        });

        expect(state.isMaximized).toBe(true);
        expect(state.width).toBe(firstDisplay.width - 10);
        expect(state.height).toBe(firstDisplay.height - 10);
      });

      it("keeps the size and position of a window that fits the display it was on", async () => {
        const state = await getWindowState({
          width: 2914,
          height: 1606,
          x: 2000,
          y: 50,
          isMaximized: false,
          displayBounds: largerDisplay,
        });

        expect(state).toMatchObject({
          isMaximized: false,
          width: 2914,
          height: 1606,
          x: 2000,
          y: 50,
        });
      });

      it("centers the window on the primary display when its display is gone", async () => {
        const state = await getWindowState({
          width: 1000,
          height: 700,
          x: 6000,
          y: 50,
          isMaximized: false,
          displayBounds: { x: 5000, y: 0, width: 2560, height: 1440 },
        });

        expect(state).toMatchObject({ isMaximized: false, x: 460, y: 290 });
      });

      it("does not treat Wayland as the Ozone platform outside Linux", async () => {
        setPlatform("win32");
        ozonePlatform = "wayland";

        const state = await getWindowState({
          width: 2914,
          height: 1606,
          x: 0,
          y: 0,
          isMaximized: false,
          displayBounds: firstDisplay,
        });

        expect(state.isMaximized).toBe(true);
      });
    });
  });
});

describe("isConfinedSnap", () => {
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;
  const originalSnap = process.env.SNAP;
  const originalSnapName = process.env.SNAP_NAME;

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  const setExecPath = (execPath: string) => {
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
  };

  // Spied rather than module-mocked: this spec's import graph reaches the SDK, which reads its
  // WASM binary through fs at import time, so `jest.mock("fs")` breaks the whole suite.
  let readFileSync: jest.SpyInstance;

  const setCgroup = (contents: string) => {
    readFileSync.mockReturnValue(contents);
  };

  const setCgroupUnreadable = () => {
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, open '/proc/self/cgroup'");
    });
  };

  // A confined snap's cgroup path contains snap.<snap-name>.<app-name>
  const confinedCgroup = (snapName: string) =>
    `0::/user.slice/user-1000.slice/user@1000.service/app.slice/snap.${snapName}.${snapName}.f0e1d2c3.scope\n`;

  beforeEach(() => {
    readFileSync = jest.spyOn(fs, "readFileSync");
    setPlatform("linux");
    // Only the stable snap path is a valid default; each test sets what it needs.
    setExecPath("/snap/bitwarden/x1/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    if (originalSnap === undefined) {
      delete process.env.SNAP;
    } else {
      process.env.SNAP = originalSnap;
    }
    if (originalSnapName === undefined) {
      delete process.env.SNAP_NAME;
    } else {
      process.env.SNAP_NAME = originalSnapName;
    }
  });

  it("returns true for the stable snap", () => {
    setExecPath("/snap/bitwarden/x1/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
    expect(isConfinedSnap()).toBe(true);
  });

  it("returns true for the beta snap", () => {
    setExecPath("/snap/bitwarden-beta/x1/opt/Bitwarden Beta/bitwarden");
    setCgroup(confinedCgroup("bitwarden-beta"));
    expect(isConfinedSnap()).toBe(true);
  });

  // Fedora, Arch and openSUSE mount snaps at /var/lib/snapd/snap; execPath is canonicalized, so
  // it carries that root rather than the /snap compatibility symlink.
  it("returns true on distros that mount snaps outside /snap", () => {
    setExecPath("/var/lib/snapd/snap/bitwarden/x1/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
    expect(isConfinedSnap()).toBe(true);
  });

  it("returns false when execPath is outside a snap mount", () => {
    setExecPath("/opt/Bitwarden/bitwarden");
    expect(isConfinedSnap()).toBe(false);
  });

  // snapd's per-user data dir is user-writable, so a copy planted there must not pass as confined.
  it("returns false for a snap-lookalike path under the user's home", () => {
    setExecPath("/home/user/snap/bitwarden/current/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
    expect(isConfinedSnap()).toBe(false);
  });

  it("returns false when execPath belongs to another snap", () => {
    setExecPath("/snap/some-terminal/x1/usr/bin/some-terminal");
    setCgroup(confinedCgroup("some-terminal"));
    expect(isConfinedSnap()).toBe(false);
  });

  it("does not read the cgroup when execPath already rules out a snap", () => {
    setExecPath("/opt/Bitwarden/bitwarden");
    isConfinedSnap();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("returns false when the cgroup does not name a bitwarden snap", () => {
    setCgroup("0::/user.slice/user-1000.slice/session-2.scope\n");
    expect(isConfinedSnap()).toBe(false);
  });

  it("returns false when the cgroup cannot be read", () => {
    setCgroupUnreadable();
    expect(isConfinedSnap()).toBe(false);
  });

  it("returns false on non-Linux platforms", () => {
    setPlatform("darwin");
    expect(isConfinedSnap()).toBe(false);
  });

  it("is not fooled by snap env vars alone, unlike isSnapStore", () => {
    setExecPath("/opt/Bitwarden/bitwarden");
    process.env.SNAP = "/snap/bitwarden/x1";
    process.env.SNAP_NAME = "bitwarden";

    expect(isConfinedSnap()).toBe(false);
    expect(isSnapStore()).toBe(true);
  });
});
