// Preload: exposes exactly two bridges to the page and nothing else.
//  1. window.__smartspectraBridge — the SDK's own bridge (imported for its side effect).
//  2. window.drift — Drift's key and settings calls.
import '@smartspectra/node-sdk/preload';
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DriftBridge, type Settings } from '../shared/ipc';

const bridge: DriftBridge = {
    key: {
        status: () => ipcRenderer.invoke(IPC.keyStatus),
        save: (key: string) => ipcRenderer.invoke(IPC.keySave, key),
        load: () => ipcRenderer.invoke(IPC.keyLoad),
        remove: () => ipcRenderer.invoke(IPC.keyRemove),
    },
    settings: {
        get: () => ipcRenderer.invoke(IPC.settingsGet),
        save: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.settingsSave, patch),
    },
    openPortal: () => ipcRenderer.invoke(IPC.openPortal),
};

contextBridge.exposeInMainWorld('drift', bridge);
