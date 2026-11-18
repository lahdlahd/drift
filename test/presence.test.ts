import { describe, it, expect, beforeAll } from 'vitest';
import { PresenceTracker, computeBaseline, type PresenceState } from '../src/renderer/sensing/presence';

// Real-hardware regression: Joel's Milestone 0 run, replayed through the tracker.
import { loadRun, type Ev, type CueWindow } from './replay';

let events: Ev[];
let windows: CueWindow[];
let trialSpans: Record<string, { from: number; to: number }>;

beforeAll(() => {
    const run = loadRun();
    events = run.events;
    windows = run.windows;
    trialSpans = run.spans;
});

function baselineFromRun(): number {
    const span = trialSpans.baseline!;
    const ears = events.filter((e): e is ['e', number, number, number] => e[0] === 'e' && e[1] >= span.from && e[1] <= span.from + 60e6)
        .map((e) => (e[2] + e[3]) / 2);
    return computeBaseline(ears)!;
}

/** Replays the run, sampling the tracker every 100 ms; returns state episodes. */
function replay(tracker: PresenceTracker) {
    const episodes: { state: PresenceState; at: number; since: number | null }[] = [];
    let prev: PresenceState | null = null;
    let nextTick = events[0]![1];
    const tick = (now: number) => {
        const s = tracker.snapshot(now);
        if (s.state !== prev) { episodes.push({ state: s.state, at: now, since: s.since }); prev = s.state; }
    };
    for (const e of events) {
        while (nextTick <= e[1]) { tick(nextTick); nextTick += 100_000; }
        if (e[0] === 'b') tracker.feedBlinkSample(e[1]);
        else if (e[0] === 'e') tracker.feedLandmarks(e[1], (e[2] + e[3]) / 2, e[2] * 1000 + e[3]);
    }
    return episodes;
}

const startsIn = (eps: ReturnType<typeof replay>, state: PresenceState, from: number, to: number) =>
    eps.filter((x) => x.state === state && x.at >= from && x.at <= to);

describe('PresenceTracker on the real M0 run (standard sensitivity)', () => {
    it('calibrates an open-eye baseline close to the measured 0.21', () => {
        expect(baselineFromRun()).toBeGreaterThan(0.18);
        expect(baselineFromRun()).toBeLessThan(0.25);
    });

    it('detects 10/10 three-second closures, each with onset at the cue', () => {
        const tr = new PresenceTracker();
        tr.setBaseline(baselineFromRun());
        const eps = replay(tr);
        const c3 = windows.filter((w) => w.trial === 'closed3');
        expect(c3).toHaveLength(10);
        for (const w of c3) {
            const hit = startsIn(eps, 'eyes-closed', w.start, w.end + 2e6);
            expect(hit.length, `closure #${w.rep + 1}`).toBeGreaterThanOrEqual(1);
            const onsetS = (hit[0]!.since! - w.start) / 1e6;
            expect(onsetS).toBeGreaterThan(-0.5);
            expect(onsetS).toBeLessThan(1.5);
        }
    });

    it('ignores the 2 s closure and catches the 4 s and 6 s ones', () => {
        const tr = new PresenceTracker();
        tr.setBaseline(baselineFromRun());
        const eps = replay(tr);
        const c = windows.filter((w) => w.trial === 'closed246');
        const caught = c.map((w) => startsIn(eps, 'eyes-closed', w.start, w.end + 2e6).length > 0);
        expect(caught).toEqual([false, true, true]);
    });

    it('raises no eyes-closed or away during 5 min of normal watching, notes or phone', () => {
        const tr = new PresenceTracker();
        tr.setBaseline(baselineFromRun());
        const eps = replay(tr);
        for (const trial of ['baseline', 'notes', 'phone']) {
            const span = trialSpans[trial]!;
            expect(startsIn(eps, 'eyes-closed', span.from, span.to), trial).toHaveLength(0);
            expect(startsIn(eps, 'away', span.from, span.to), trial).toHaveLength(0);
        }
    });

    it('detects both times the user left the frame, within 8 s of the cue', () => {
        const tr = new PresenceTracker();
        tr.setBaseline(baselineFromRun());
        const eps = replay(tr);
        const leaves = windows.filter((w) => w.trial === 'leave');
        expect(leaves).toHaveLength(2);
        for (const w of leaves) {
            const hit = startsIn(eps, 'away', w.start, w.start + 8e6);
            expect(hit.length, `leave #${w.rep + 1}`).toBe(1);
        }
    });

    it('reports looking-away (status only) while looking down at notes', () => {
        const tr = new PresenceTracker();
        tr.setBaseline(baselineFromRun());
        const eps = replay(tr);
        const notes = windows.filter((w) => w.trial === 'notes');
        const seen = notes.filter((w) => startsIn(eps, 'looking-away', w.start, w.end).length > 0).length;
        expect(seen).toBe(3);
    });

    it('never reports eyes-closed before calibration', () => {
        const tr = new PresenceTracker();
        const eps = replay(tr);
        expect(eps.filter((x) => x.state === 'eyes-closed')).toHaveLength(0);
    });
});

describe('computeBaseline', () => {
    it('needs enough samples and takes the median', () => {
        expect(computeBaseline([0.2, 0.3], 60)).toBeNull();
        const s = Array.from({ length: 100 }, (_, i) => 0.2 + (i % 10) / 1000);
        expect(computeBaseline(s)).toBeCloseTo(0.205, 3);
    });
});
