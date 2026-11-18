// Loads the real Milestone 0 run (eye-openness ratios, blink-sample times and
// the test cue marks; no images) for replay tests.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export type Ev = ['b', number] | ['e', number, number, number] | ['m', number, string, number | null, string, string | null, number | null];
export interface CueWindow { trial: string; rep: number; durationS: number; start: number; end: number }

export interface Run {
    events: Ev[];
    windows: CueWindow[];
    spans: Record<string, { from: number; to: number }>;
}

let cached: Run | null = null;

export function loadRun(): Run {
    if (cached) return cached;
    const raw = JSON.parse(gunzipSync(readFileSync('test/fixtures/m0-run.json.gz')).toString('utf8'));
    const events = (raw.events as Ev[]).sort((a, b) => a[1] - b[1]);
    const windows: CueWindow[] = [];
    const spans: Run['spans'] = {};
    const open = new Map<string, number>();
    for (const e of events) {
        if (e[0] !== 'm') continue;
        const [, t, trial, rep, phase, , dur] = e;
        if (phase === 'trial-start') spans[trial] = { from: t, to: Infinity };
        if (phase === 'trial-end' && spans[trial]) spans[trial]!.to = t;
        const k = `${trial}:${rep}`;
        if (phase === 'action-start') open.set(k, t);
        if (phase === 'action-end' && open.has(k)) windows.push({ trial, rep: rep ?? 0, durationS: dur ?? 0, start: open.get(k)!, end: t });
    }
    cached = { events, windows, spans };
    return cached;
}
