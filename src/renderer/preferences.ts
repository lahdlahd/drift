// Applies saved preferences to the tracker and the drift engine in one place.
import { bridge } from './bridge';
import { tracker } from './usePresence';
import { engine } from './drift/instance';
import { SENSITIVITY } from './sensing/presence';
import type { Settings } from '../shared/ipc';

export function applyPreferences(s: Settings) {
    tracker.configure(SENSITIVITY[s.sensitivity]);
    engine.configure({ rewindSeconds: s.rewindSeconds, lookAwayPauseS: s.lookAwaySeconds > 0 ? s.lookAwaySeconds : null });
}

export async function savePreferences(patch: Partial<Settings>): Promise<Settings> {
    const s = await bridge().settings.save(patch);
    applyPreferences(s);
    return s;
}

export const SENSITIVITY_LABEL = {
    relaxed: 'Relaxed: eyes closed 5 s, away 6 s',
    standard: 'Standard: eyes closed 3 s, away 4 s',
    strict: 'Strict: eyes closed 2 s, away 3 s',
} as const;

export const LOOK_AWAY_OPTIONS: { value: number; label: string }[] = [
    { value: 0, label: 'Never' },
    { value: 10, label: 'After 10 seconds' },
    { value: 20, label: 'After 20 seconds' },
    { value: 40, label: 'After 40 seconds' },
];

export const REWIND_OPTIONS = [10, 20, 30, 45, 60];
