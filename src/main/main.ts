// Drift — Electron main process.
// Security model follows Presage's official Electron quickstart: context isolation,
// sandboxed renderer, the SDK bridge bound per window, camera-only permission for
// our own local page, no navigation or popups.
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { bindSmartSpectraIpc } from '@smartspectra/node-sdk/main';
import { IPC } from '../shared/ipc';
import { KeyStore, KeyStoreError, type FileOps } from './keyStore';
import { SettingsStore } from './settingsStore';

const PORTAL_URL = 'https://physiology.presagetech.com/';

// Packaged builds load the native SDK runtime from resources/smartspectra (see the
// official quickstart); in development the per-platform npm package is used.
if (app.isPackaged) {
    const lib = ({ win32: 'smartspectra_capi.dll', darwin: 'libsmartspectra_capi.dylib', linux: 'libsmartspectra_capi.so' } as Record<string, string>)[process.platform];
    if (lib) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', lib);
}

const files: FileOps = {
    exists: (p) => fs.existsSync(p),
    read: (p) => fs.readFileSync(p),
    write: (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d, { mode: 0o600 }); },
    remove: (p) => fs.rmSync(p, { force: true }),
};

let keyStore: KeyStore;
let settings: SettingsStore;
let mainWindow: BrowserWindow | null = null;

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
    const url = e.senderFrame?.url ?? '';
    return url.startsWith('file://') && e.sender === mainWindow?.webContents;
}

function handle(channel: string, fn: (...args: unknown[]) => unknown) {
    ipcMain.handle(channel, async (e, ...args) => {
        if (!isTrustedSender(e)) throw new Error('Untrusted sender');
        try {
            return await fn(...args);
        } catch (err) {
            // Only pass safe, user-facing messages back to the UI.
            if (err instanceof KeyStoreError) throw new Error(err.message);
            throw new Error('Something went wrong on this computer.');
        }
    });
}

function registerIpc() {
    handle(IPC.keyStatus, () => keyStore.status());
    handle(IPC.keySave, (key) => keyStore.save(key));
    handle(IPC.keyLoad, () => keyStore.load());
    handle(IPC.keyRemove, () => keyStore.remove());
    handle(IPC.settingsGet, () => settings.get());
    handle(IPC.settingsSave, (patch) => settings.save(patch));
    handle(IPC.openPortal, () => shell.openExternal(PORTAL_URL));
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 620,
        show: false,
        title: 'Drift',
        backgroundColor: '#111418',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });
    mainWindow = win;
    bindSmartSpectraIpc(win);

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { mainWindow = null; });
    const selfTest = process.env.DRIFT_SELFTEST === '1';
    win.loadFile(path.join(__dirname, 'index.html'), selfTest ? { hash: 'selftest' } : undefined);
    if (selfTest) runSelfTest(win);
}

// Headless smoke test for development only (DRIFT_SELFTEST=1): prints the UI's
// self-report and quits. Never active in normal use.
function runSelfTest(win: BrowserWindow) {
    win.webContents.on('console-message', (_e, _level, msg) => {
        const shot = /^\[shot\] ([a-z0-9-]+)$/.exec(msg);
        const dir = process.env.DRIFT_SELFTEST_SHOTS;
        if (shot && dir) {
            void win.webContents.capturePage().then((img) => {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, `${shot[1]}.png`), img.toPNG());
            });
            return;
        }
        console.log('[renderer]', msg);
    });
    win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
            try {
                const report = await win.webContents.executeJavaScript('window.__driftSelfTest ? window.__driftSelfTest() : "no self-test hook"');
                console.log('[selftest]', typeof report === 'string' ? report : JSON.stringify(report));
            } catch (e) {
                console.log('[selftest] failed', e);
            }
            app.quit();
        }, 1500);
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    });

    app.whenReady().then(() => {
        const dir = process.env.DRIFT_USER_DATA ?? app.getPath('userData');
        // Self-test on a Linux CI box without a secret store: use a clearly marked
        // test-only encryptor so the flow can be exercised. Never used otherwise.
        const encryptor = process.env.DRIFT_SELFTEST === '1' && !safeStorage.isEncryptionAvailable()
            ? {
                isEncryptionAvailable: () => true,
                encryptString: (v: string) => Buffer.from(`SELFTEST:${Buffer.from(v).toString('base64')}`),
                decryptString: (b: Buffer) => Buffer.from(b.toString().replace(/^SELFTEST:/, ''), 'base64').toString(),
            }
            : safeStorage;
        keyStore = new KeyStore(path.join(dir, 'presage-key.bin'), encryptor, files);
        settings = new SettingsStore(path.join(dir, 'settings.json'), files);
        registerIpc();

        // Camera only (never the microphone), and only for Drift's own page.
        const allowCamera = (url: string, mediaTypes: string[] | undefined) =>
            url.startsWith('file://') && Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'video';
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
            const url = (details as { requestingUrl?: string }).requestingUrl ?? wc?.getURL() ?? '';
            const types = (details as { mediaTypes?: string[] }).mediaTypes;
            callback(permission === 'media' && allowCamera(url, types));
        });

        createWindow();
    });

    app.on('window-all-closed', () => app.quit());
}
