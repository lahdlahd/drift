// Loads the real Milestone 0 run (eye-openness ratios, blink-sample times and
// the test cue marks; no images) for replay tests.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export type Ev = ['b', number] | ['e', number, number, number] | ['v', number, string] | ['m', number, string, number | null, string, string | null, number | null];
export interface CueWindow { trial: string; rep: number; durationS: number; start: number; end: number }

export interface Run {
    events: Ev[];
    windows: CueWindow[];
    spans: Record<string, { from: number; to: number }>;
}

const cache = new Map<string, Run>();

export function loadRun(name = 'm0-run'): Run {
    const hit = cache.get(name);
    if (hit) return hit;
    const raw = JSON.parse(gunzipSync(readFileSync(`test/fixtures/${name}.json.gz`)).toString('utf8'));
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
    const run = { events, windows, spans };
    cache.set(name, run);
    return run;
}

/**
 * Feeds one recorded landmark frame. The fixture holds eye-openness ratios rounded to
 * 4 decimals, not raw landmarks, so movement is approximated as "the ratios changed".
 */
const lastByTracker = new WeakMap<object, string>();
export function feed(tracker: { feedLandmarks(t: number, ear: number | null, motion: number): void }, e: ['e', number, number, number]) {
    const key = `${e[2]}:${e[3]}`;
    const moved = lastByTracker.get(tracker) !== key;
    lastByTracker.set(tracker, key);
    tracker.feedLandmarks(e[1], (e[2] + e[3]) / 2, moved ? 1 : 0);
}
