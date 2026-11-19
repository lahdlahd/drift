// Small JSON settings file in Electron's user-data folder. Holds no key,
// no video and no measurements other than the user's eye-openness baseline.
import { DEFAULT_SETTINGS, type Settings, type SensitivityPreset } from '../shared/ipc';
import type { FileOps } from './keyStore';

const PRESETS: SensitivityPreset[] = ['relaxed', 'standard', 'strict'];

export function sanitizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
    const out: Settings = { ...base };
    if (!input || typeof input !== 'object') return out;
    const s = input as Record<string, unknown>;
    if (typeof s.consentAccepted === 'boolean') out.consentAccepted = s.consentAccepted;
    if (s.eyeBaseline === null) out.eyeBaseline = null;
    else if (typeof s.eyeBaseline === 'number' && s.eyeBaseline > 0.05 && s.eyeBaseline < 1) out.eyeBaseline = s.eyeBaseline;
    if (typeof s.sensitivity === 'string' && PRESETS.includes(s.sensitivity as SensitivityPreset)) {
        out.sensitivity = s.sensitivity as SensitivityPreset;
    }
    if (typeof s.rewindSeconds === 'number' && s.rewindSeconds >= 5 && s.rewindSeconds <= 120) {
        out.rewindSeconds = Math.round(s.rewindSeconds);
    }
    if (typeof s.lookAwaySeconds === 'number' && [0, 10, 20, 40].includes(s.lookAwaySeconds)) out.lookAwaySeconds = s.lookAwaySeconds;
    return out;
}

export class SettingsStore {
    private cache: Settings | null = null;
    constructor(private readonly path: string, private readonly files: FileOps) {}

    get(): Settings {
        if (this.cache) return this.cache;
        let parsed: unknown = null;
        try {
            if (this.files.exists(this.path)) parsed = JSON.parse(this.files.read(this.path).toString('utf8'));
        } catch { parsed = null; }
        this.cache = sanitizeSettings(parsed);
        return this.cache;
    }

    save(patch: unknown): Settings {
        const next = sanitizeSettings(patch, this.get());
        this.files.write(this.path, Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
        this.cache = next;
        return next;
    }
}
