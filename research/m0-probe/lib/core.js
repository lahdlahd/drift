// Pure helpers shared by the probe renderer, the analyser and the tests.
'use strict';

// Test plan. `expect` is what the person is asked to do during the action phase.
// Durations in seconds.
const TRIALS = [
    { id: 'baseline',  name: 'Normal watching', expect: 'normal', reps: 1,  actionS: 300, restS: 0,
      say: 'Look at the screen as if watching a lecture. Blink normally. 5 minutes.' },
    { id: 'closed3',   name: 'Eyes closed 3 s', expect: 'closed', reps: 10, actionS: 3,   restS: 6,
      say: 'High beep: close your eyes. Two low beeps: open them.' },
    { id: 'closed246', name: 'Eyes closed 2 / 4 / 6 s', expect: 'closed', reps: 3, actionS: [2, 4, 6], restS: 6,
      say: 'High beep: close your eyes. Two low beeps: open them.' },
    { id: 'notes',     name: 'Look down at notes 10 s', expect: 'down', reps: 3, actionS: 10, restS: 6,
      say: 'High beep: look down at a notebook as if writing. Two low beeps: look back at the screen.' },
    { id: 'phone',     name: 'Turn to your phone 10 s', expect: 'away', reps: 2, actionS: 10, restS: 6,
      say: 'High beep: turn your head to the side as if checking your phone. Two low beeps: face the screen.' },
    { id: 'leave',     name: 'Leave the frame 10 s', expect: 'absent', reps: 2, actionS: 10, restS: 10,
      say: 'High beep: stand up and step out of view. Two low beeps: sit back down.' },
];

function actionSeconds(trial, rep) {
    return Array.isArray(trial.actionS) ? trial.actionS[rep] : trial.actionS;
}

function trialTotalSeconds(trial) {
    let s = 0;
    for (let r = 0; r < trial.reps; r++) s += actionSeconds(trial, r) + trial.restS;
    return s;
}

// Timestamps from the SDK can be number, bigint or protobufjs Long.
function tsToNumber(ts) {
    if (ts == null) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'bigint') return Number(ts);
    if (typeof ts.toNumber === 'function') return ts.toNumber();
    return Number(ts);
}

// Eye aspect ratio from a 478-point face mesh. ASSUMPTION: SmartSpectra's 478
// landmarks follow the MediaPipe Face Mesh (with iris) index layout. M0 checks
// this empirically: if EAR does not drop when the eyes close, the assumption is wrong.
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const LEFT_EYE  = [362, 385, 387, 263, 373, 380];

function dist(a, b) {
    const dx = (a.x || 0) - (b.x || 0), dy = (a.y || 0) - (b.y || 0);
    return Math.hypot(dx, dy);
}

function eyeAspectRatio(points, idx) {
    const p = idx.map((i) => points[i]);
    if (p.some((q) => !q)) return null;
    const horiz = dist(p[0], p[3]);
    if (horiz === 0) return null;
    return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * horiz);
}

function earFromLandmarks(points) {
    if (!Array.isArray(points) || points.length < 400) return null;
    const r = eyeAspectRatio(points, RIGHT_EYE);
    const l = eyeAspectRatio(points, LEFT_EYE);
    if (r == null || l == null) return null;
    return { left: l, right: r, mean: (l + r) / 2 };
}

module.exports = { TRIALS, actionSeconds, trialTotalSeconds, tsToNumber, earFromLandmarks };
