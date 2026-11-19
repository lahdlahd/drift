import { describe, it, expect } from 'vitest';
import { feed, loadRun, type Run } from './replay';
import { PresenceTracker, computeBaseline } from '../src/renderer/sensing/presence';
import { DriftEngine, formatTime, type Drift } from '../src/renderer/drift/engine';

// Replays the real M0 run as if a lecture were playing the whole time:
// the video pauses when the engine says so, and resumes ("Continue") once
// the engine reports the user is back.
function simulate(run: Run, opts: { playing?: (t: number) => boolean; answer?: 'continue' | 'rewind' } = {}) {
    const span = run.spans.baseline!;
    const ears = run.events.filter((e): e is ['e', number, number, number] => e[0] === 'e' && e[1] >= span.from && e[1] <= span.from + 60e6)
        .map((e) => (e[2] + e[3]) / 2);
    const tracker = new PresenceTracker();
    tracker.setBaseline(computeBaseline(ears)!);
    const engine = new DriftEngine({ rewindSeconds: 30 });

    let video = 0;
    let driftPaused = false;
    let lastTick = run.events[0]![1];
    const paused: Drift[] = [];
    const returned: Drift[] = [];
    let next = lastTick;

    const tick = (now: number) => {
        const wantPlay = opts.playing ? opts.playing(now) : true;
        const playing = wantPlay && !driftPaused;
        if (playing) video += (now - lastTick) / 1e6;
        lastTick = now;
        for (const ev of engine.tick(now, tracker.snapshot(now), { playing, time: video })) {
            if (ev.type === 'pause') { driftPaused = true; paused.push(ev.drift); }
            if (ev.type === 'returned') {
                returned.push(ev.drift);
                const seek = engine.answer(opts.answer ?? 'continue');
                if (seek != null) video = seek;
                driftPaused = false;
            }
        }
    };
    for (const e of run.events) {
        while (next <= e[1]) { tick(next); next += 100_000; }
        if (e[0] === 'b') tracker.feedBlinkSample(e[1]);
        else if (e[0] === 'e') feed(tracker, e);
    }
    return { paused, returned, engine };
}

const inWindow = (d: Drift, from: number, to: number) => d.pausedT >= from && d.pausedT <= to;

describe('DriftEngine on the real M0 run', () => {
    const run = loadRun();

    it('pauses for every 3 s closure, at the threshold, marked at the onset', () => {
        const { paused } = simulate(run);
        const c3 = run.windows.filter((w) => w.trial === 'closed3');
        for (const w of c3) {
            const d = paused.find((p) => inWindow(p, w.start, w.end + 2e6));
            expect(d, `closure #${w.rep + 1}`).toBeDefined();
            expect(d!.reason).toBe('eyes-closed');
            // Paused within 0.5 s of the 3 s threshold being reached.
            const lateS = (d!.pausedT - d!.onsetT) / 1e6 - 3;
            expect(lateS).toBeGreaterThanOrEqual(0);
            expect(lateS).toBeLessThanOrEqual(0.5);
            // Marker within 1.5 s of the cue, and the video was paused ~3 s after it.
            expect((d!.onsetT - w.start) / 1e6).toBeLessThan(1.5);
            expect(d!.pausedAtVideo - d!.onsetVideo).toBeGreaterThan(2.9);
            expect(d!.pausedAtVideo - d!.onsetVideo).toBeLessThan(3.6);
        }
    });

    it('pauses for both seat-leaves as "away" and notices the return', () => {
        const { paused, returned } = simulate(run);
        for (const w of run.windows.filter((x) => x.trial === 'leave')) {
            const d = paused.find((p) => inWindow(p, w.start, w.end + 2e6));
            expect(d?.reason).toBe('away');
            expect(returned).toContain(d);
        }
    });

    it('never pauses during normal watching, notes or phone', () => {
        const { paused } = simulate(run);
        for (const trial of ['baseline', 'notes', 'phone']) {
            const s = run.spans[trial]!;
            expect(paused.filter((p) => inWindow(p, s.from, s.to)), trial).toHaveLength(0);
        }
    });

    it('raises exactly the expected drifts over the whole 12-minute run', () => {
        const { paused, returned } = simulate(run);
        // 10 × 3 s, the 4 s and 6 s closures, 2 leaves. The 2 s closure is ignored.
        expect(paused.filter((p) => p.reason === 'eyes-closed')).toHaveLength(12);
        expect(paused.filter((p) => p.reason === 'away')).toHaveLength(2);
        expect(returned).toHaveLength(paused.length);
    });

    it('rewinds to 30 s before the onset', () => {
        const { paused } = simulate(run, { answer: 'rewind' });
        expect(paused.length).toBeGreaterThan(0);
        for (const d of paused) expect(d.rewindTo).toBeCloseTo(Math.max(0, d.onsetVideo - 30), 6);
    });

    it('never pauses when the user has paused the video themselves', () => {
        const { paused } = simulate(run, { playing: () => false });
        expect(paused).toHaveLength(0);
    });
});

describe('formatTime', () => {
    it('formats minutes and hours', () => {
        expect(formatTime(0)).toBe('0:00');
        expect(formatTime(872.9)).toBe('14:32');
        expect(formatTime(3725)).toBe('1:02:05');
        expect(formatTime(Infinity)).toBe('--:--');
        expect(formatTime(NaN)).toBe('--:--');
    });
});

describe('DriftEngine.interrupt (SDK stopped mid-lecture)', () => {
    it('pauses once, marks the spot, and waits for the user to be back', async () => {
        const { PresenceTracker } = await import('../src/renderer/sensing/presence');
        const engine = new DriftEngine({ rewindSeconds: 30 });
        const evs = engine.interrupt(10e6, 95);
        expect(evs).toHaveLength(1);
        expect(evs[0]!.drift).toMatchObject({ reason: 'signal-lost', onsetVideo: 95, rewindTo: 65 });
        expect(engine.interrupt(11e6, 96)).toHaveLength(0); // only one card at a time
        const tr = new PresenceTracker();
        tr.setBaseline(0.22);
        let returned = false;
        for (let t = 12e6; t < 15e6; t += 33_333) {
            tr.feedLandmarks(t, 0.22, 2e-3);
            for (const e of engine.tick(t, tr.snapshot(t), { playing: false, time: 95 })) if (e.type === 'returned') returned = true;
        }
        expect(returned).toBe(true);
        expect(engine.answer('rewind')).toBe(65);
    });
});
