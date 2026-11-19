// The only messages Drift's own preload bridge carries between the UI and the
// main process. The SmartSpectra SDK uses its own separate channel.

export const IPC = {
    keyStatus: 'drift:key:status',
    keySave: 'drift:key:save',
    keyLoad: 'drift:key:load',
    keyRemove: 'drift:key:remove',
    settingsGet: 'drift:settings:get',
    settingsSave: 'drift:settings:save',
    openPortal: 'drift:open-portal',
} as const;

export interface KeyStatus {
    /** A key is saved on this computer. */
    stored: boolean;
    /** The operating system can encrypt it (Windows DPAPI, macOS Keychain, Linux secret store). */
    encryptionAvailable: boolean;
}

export type SensitivityPreset = 'relaxed' | 'standard' | 'strict';

export interface Settings {
    consentAccepted: boolean;
    /** Median eye openness with eyes open, measured during the camera check. */
    eyeBaseline: number | null;
    sensitivity: SensitivityPreset;
    rewindSeconds: number;
    /** Pause after this many seconds without seeing the face; 0 = off. */
    lookAwaySeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
    consentAccepted: false,
    eyeBaseline: null,
    sensitivity: 'standard',
    rewindSeconds: 30,
    lookAwaySeconds: 20,
};

/** What the preload exposes on `window.drift`. */
export interface DriftBridge {
    key: {
        status(): Promise<KeyStatus>;
        save(key: string): Promise<KeyStatus>;
        load(): Promise<string | null>;
        remove(): Promise<KeyStatus>;
    };
    settings: {
        get(): Promise<Settings>;
        save(patch: Partial<Settings>): Promise<Settings>;
    };
    openPortal(): Promise<void>;
}
