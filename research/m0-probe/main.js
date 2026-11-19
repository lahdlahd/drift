// Drift M0 probe — Electron main process.
// Follows the integration pattern of Presage's official electron-quickstart:
// the SDK's own preload bridge + bindSmartSpectraIpc, context isolation, sandbox.
'use strict';

const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

function createWindow() {
    const win = new BrowserWindow({
        width: 1180,
        height: 820,
        backgroundColor: '#111418',
        title: 'Drift — M0 signal probe',
        webPreferences: {
            preload: require.resolve('@smartspectra/node-sdk/preload'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });

    bindSmartSpectraIpc(win);

    // Only our own local page; no popups, no navigation away.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.loadFile(path.join(__dirname, 'index.html'));

    // Developer self-test (only with DRIFT_PROBE_SELFTEST=1): loads the page,
    // presses Start with a dummy key, prints what happened, then quits.
    if (process.env.DRIFT_PROBE_SELFTEST === '1') {
        win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
        win.webContents.once('did-finish-load', async () => {
            await win.webContents.executeJavaScript(`
                document.getElementById('btn-camcheck').click();`);
            await new Promise((r) => setTimeout(r, 8000));
            await win.webContents.executeJavaScript(`
                document.getElementById('api-key').value = 'selftest-dummy-key';
                document.getElementById('btn-start').click();`);
            setTimeout(async () => {
                const out = await win.webContents.executeJavaScript(`JSON.stringify({
                    camcheck: document.getElementById('camcheck').textContent,
                    camfps: document.getElementById('camfps').textContent,
                    proc: document.getElementById('proc').textContent,
                    val: document.getElementById('val').textContent,
                    error: document.getElementById('error').textContent,
                    trials: document.querySelectorAll('.trial').length })`);
                console.log('[selftest]', out);
                await win.webContents.executeJavaScript(`document.getElementById('btn-stop').click();`);
                setTimeout(() => app.quit(), 3000);
            }, 6000);
        });
    }
}

app.whenReady().then(() => {
    // Grant camera only (no microphone), only to our local page.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
        const types = (details && details.mediaTypes) || [];
        const cameraOnly = types.length === 1 && types[0] === 'video';
        callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
    });
    createWindow();
});

app.on('window-all-closed', () => app.quit());
