import type { DriftBridge } from '../shared/ipc';

declare global {
    interface Window { drift?: DriftBridge }
}

export function bridge(): DriftBridge {
    if (!window.drift) throw new Error('Drift bridge is unavailable (preload not loaded).');
    return window.drift;
}

/** Electron wraps errors from ipcMain.handle; keep only our message. */
export function cleanError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
