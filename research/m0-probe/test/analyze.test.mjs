import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, closedRuns } from '../analyze.mjs';
import core from '../lib/core.js';

// Build a synthetic trace that mimics the probe's log format.
// mode: 'sustained' = blink flag stays true for the whole closure
//       'pulse'     = blink flag only fires briefly at closure onset (the risk we are testing for)
//       'broken'    = neither blink flag nor landmarks react to closure
function synth(mode) {
    const events = [];
    const t0 = 1_700_000_000_000_000; // µs
    let t = t0;
    const hz = 30, dt = 1e6 / hz;
    const closedIntervals = [];
    const push = (e) => events.push(e);
    const mark = (trial, rep, phase, extra = {}) => push({ type: 'mark', t, trial, rep, phase, ...extra });

    function advance(seconds, { closed = false, code = 'Ok', normalBlinks = false } = {}) {
        const end = t + seconds * 1e6;
        if (closed) closedIntervals.push([t + 250_000, end]); // 0.25 s reaction lag
        push({ type: 'val', t, code: 0, name: code, hint: '' });
        let k = 0;
        while (t < end) {
            const inClosure = closedIntervals.some(([a, b]) => t >= a && t < b);
            const inNormalBlink = normalBlinks && (k % 120) < 6; // 0.2 s blink every 4 s
            let flag = inClosure || inNormalBlink;
            if (mode === 'pulse' && inClosure) flag = closedIntervals.some(([a]) => t >= a && t < a + 300_000);
            if (mode === 'broken' && inClosure) flag = false;
            push({ type: 'blink', t, detected: flag, stable: true });
            const earClosed = (inClosure && mode !== 'broken') || inNormalBlink;
            push({ type: 'ear', t, l: earClosed ? 0.08 : 0.3, r: earClosed ? 0.08 : 0.3, stable: true });
            if (k % hz === 0) push({ type: 'rate', t, sent: 30, dropped: 0, blink: 30 });
            t += dt; k++;
        }
    }

    for (const trial of core.TRIALS) {
        mark(trial.id, undefined, 'trial-start');
        advance(2, { normalBlinks: true });
        for (let rep = 0; rep < trial.reps; rep++) {
            const secs = core.actionSeconds(trial, rep);
            mark(trial.id, rep, 'action-start', { expect: trial.expect, durationS: secs });
            const code = trial.expect === 'absent' ? 'NoFaceFound' : trial.expect === 'away' ? 'FaceNotForward' : 'Ok';
            advance(secs, { closed: trial.expect === 'closed', code, normalBlinks: trial.expect === 'normal' });
            mark(trial.id, rep, 'action-end', { expect: trial.expect, durationS: secs });
            if (trial.restS) advance(trial.restS, { normalBlinks: true });
        }
        mark(trial.id, undefined, 'trial-end');
    }
    return { meta: { sdkVersion: 'test', faceOnly: true }, events };
}

test('closedRuns merges consecutive closed samples and splits on open', () => {
    const s = [0, 1, 2, 3, 4, 5].map((i) => ({ t: i * 100_000, closed: i < 3 }));
    const runs = closedRuns(s);
    assert.equal(runs.length, 1);
    assert.ok(Math.abs(runs[0].dur - 0.3) < 1e-9);
});

test('GO when the blink flag holds through a sustained closure', () => {
    const r = analyze(synth('sustained'));
    assert.match(r.verdict, /^GO/);
    assert.equal(r.detectors[0].pass, true);
    const t25 = r.detectors[0].byThreshold.find((x) => x.T === 2.5);
    assert.equal(t25.hits3, 10);
    assert.equal(t25.fpBaseline, 0);
});

test('blink flag fails but landmark EAR fallback still gives GO when the flag only pulses', () => {
    const r = analyze(synth('pulse'));
    assert.equal(r.detectors[0].pass, false);
    assert.ok(r.detectors.slice(1).some((d) => d.pass));
    assert.match(r.verdict, /^GO — "Landmark EAR/);
});

test('NO-GO when nothing reacts to eye closure', () => {
    const r = analyze(synth('broken'));
    assert.match(r.verdict, /^NO-GO/);
});

test('validation analysis sees NoFaceFound when the person leaves', () => {
    const r = analyze(synth('sustained'));
    const leave = r.validation.perRep.filter((v) => v.trial === 'leave');
    assert.equal(leave.length, 2);
    for (const v of leave) assert.equal(v.firstTargetAfterS, 0);
});

test('EAR helper reads MediaPipe eye indices', () => {
    const pts = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
    const setEye = (idx, open) => {
        const [p1, p2, p3, p4, p5, p6] = idx;
        pts[p1] = { x: 0, y: 0 }; pts[p4] = { x: 1, y: 0 };
        pts[p2] = { x: 0.3, y: -open }; pts[p6] = { x: 0.3, y: open };
        pts[p3] = { x: 0.7, y: -open }; pts[p5] = { x: 0.7, y: open };
    };
    setEye([33, 160, 158, 133, 153, 144], 0.15);
    setEye([362, 385, 387, 263, 373, 380], 0.15);
    const e = core.earFromLandmarks(pts);
    assert.ok(Math.abs(e.mean - 0.3) < 1e-9);
    assert.equal(core.earFromLandmarks(pts.slice(0, 100)), null);
});
