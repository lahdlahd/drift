#!/usr/bin/env node
// Drift M0 trace analyser.
// Usage: node analyze.mjs <trace.json> [--json]
// Applies the M0 go/no-go gate from the Drift plan:
//   a 3 s eye closure is detected in at least 9 of 10 tries, and
//   normal watching (5 min) produces no false closure of the same length.
import { readFileSync } from 'node:fs';

const THRESHOLDS = [1.5, 2.0, 2.5, 3.0];     // candidate Drift eyes-closed thresholds, seconds
const EAR_FACTORS = [0.5, 0.65, 0.75];       // closed when EAR < factor × baseline median
const MAX_GAP_S = 0.5;                        // samples further apart than this break a run

export function closedRuns(series, maxGapS = MAX_GAP_S) {
    // series: [{t (µs), closed (bool)}] sorted by t. Returns [{start, end, dur}] in seconds-µs.
    const runs = [];
    const dts = [];
    for (let i = 1; i < series.length; i++) dts.push(series[i].t - series[i - 1].t);
    dts.sort((a, b) => a - b);
    const dt = dts.length ? dts[Math.floor(dts.length / 2)] : 33_000;
    let cur = null;
    let prevT = null;
    for (const s of series) {
        const gapOk = prevT !== null && (s.t - prevT) <= maxGapS * 1e6;
        if (s.closed) {
            if (cur && gapOk) cur.last = s.t;
            else { if (cur) runs.push(cur); cur = { first: s.t, last: s.t }; }
        } else if (cur) { runs.push(cur); cur = null; }
        prevT = s.t;
    }
    if (cur) runs.push(cur);
    return runs.map((r) => ({ start: r.first, end: r.last + dt, dur: (r.last + dt - r.first) / 1e6 }));
}

export function actionWindows(events) {
    const out = [];
    const open = new Map();
    for (const e of events) {
        if (e.type !== 'mark') continue;
        const key = `${e.trial}:${e.rep}`;
        if (e.phase === 'action-start') open.set(key, e);
        if (e.phase === 'action-end' && open.has(key)) {
            const s = open.get(key);
            out.push({ trial: e.trial, rep: e.rep, expect: e.expect, durationS: e.durationS, start: s.t, end: e.t });
            open.delete(key);
        }
    }
    return out;
}

function longestRunIn(runs, from, to) {
    let best = 0;
    for (const r of runs) {
        if (r.end <= from || r.start >= to) continue;
        best = Math.max(best, r.dur);
    }
    return best;
}

function runsWithin(runs, from, to, minS) {
    return runs.filter((r) => r.start >= from && r.start < to && r.dur >= minS);
}

function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function trialSpan(events, trial) {
    const s = events.find((e) => e.type === 'mark' && e.trial === trial && e.phase === 'trial-start');
    const e = events.find((x) => x.type === 'mark' && x.trial === trial && (x.phase === 'trial-end' || x.phase === 'trial-aborted'));
    return s && e ? { from: s.t, to: e.t } : null;
}

function evaluateDetector(name, runs, windows, events) {
    // Hits on closure tests: longest closed run overlapping [start, end + 1.5 s].
    const closedWins = windows.filter((w) => w.expect === 'closed');
    const perRep = closedWins.map((w) => ({
        trial: w.trial, rep: w.rep, askedS: w.durationS,
        measuredS: +longestRunIn(runs, w.start - 0.5e6, w.end + 1.5e6).toFixed(2),
    }));
    const base = trialSpan(events, 'baseline');
    const otherWins = windows.filter((w) => w.expect === 'down' || w.expect === 'away');
    const byT = THRESHOLDS.map((T) => {
        const c3 = perRep.filter((p) => p.trial === 'closed3');
        const hits3 = c3.filter((p) => p.measuredS >= T).length;
        const fpBase = base ? runsWithin(runs, base.from, base.to, T).length : null;
        const fpOther = otherWins.reduce((n, w) => n + runsWithin(runs, w.start, w.end + 1e6, T).length, 0);
        return { T, hits3, of3: c3.length, fpBaseline: fpBase, fpNotesPhone: fpOther };
    });
    const passing = byT.filter((r) => r.of3 >= 10 && r.hits3 >= 9 && r.fpBaseline === 0 && r.T >= 2.0);
    return { name, perRep, byThreshold: byT, pass: passing.length > 0, bestT: passing.length ? passing[passing.length - 1].T : null };
}

function validationAnalysis(events, windows) {
    const vals = events.filter((e) => e.type === 'val').sort((a, b) => a.t - b.t);
    const codeAt = (t) => { let c = null; for (const v of vals) { if (v.t <= t) c = v.name; else break; } return c; };
    const results = [];
    for (const w of windows.filter((x) => ['down', 'away', 'absent'].includes(x.expect))) {
        const counts = {};
        const stepUs = 100_000;
        for (let t = w.start; t < w.end; t += stepUs) {
            const c = codeAt(t) || 'none';
            counts[c] = (counts[c] || 0) + 1;
        }
        const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
        const share = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, +(v / total).toFixed(2)]));
        const target = w.expect === 'absent' ? 'NoFaceFound' : 'FaceNotForward';
        const first = vals.find((v) => v.t >= w.start && v.t <= w.end + 2e6 && v.name === target);
        results.push({ trial: w.trial, rep: w.rep, expect: w.expect, share,
            firstTargetAfterS: first ? +((first.t - w.start) / 1e6).toFixed(2) : null });
    }
    const base = trialSpan(events, 'baseline');
    let baselineOk = null;
    if (base) {
        let ok = 0, n = 0;
        for (let t = base.from; t < base.to; t += 100_000) { n++; if (codeAt(t) === 'Ok') ok++; }
        baselineOk = n ? +(ok / n).toFixed(2) : null;
    }
    return { perRep: results, baselineOkShare: baselineOk };
}

export function analyze(trace) {
    const events = [...trace.events].sort((a, b) => a.t - b.t);
    const windows = actionWindows(events);

    const blink = events.filter((e) => e.type === 'blink').map((e) => ({ t: e.t, closed: e.detected }));
    const blinkRuns = closedRuns(blink);
    const detectors = [evaluateDetector('SDK blink flag', blinkRuns, windows, events)];

    const ear = events.filter((e) => e.type === 'ear').map((e) => ({ t: e.t, v: (e.l + e.r) / 2 }));
    const base = trialSpan(events, 'baseline');
    const baseEar = base ? median(ear.filter((e) => e.t >= base.from && e.t <= base.to).map((e) => e.v)) : median(ear.map((e) => e.v));
    if (ear.length && baseEar) {
        for (const f of EAR_FACTORS) {
            const series = ear.map((e) => ({ t: e.t, closed: e.v < f * baseEar }));
            detectors.push(evaluateDetector(`Landmark EAR < ${f} × ${baseEar.toFixed(3)}`, closedRuns(series), windows, events));
        }
    }

    const rates = events.filter((e) => e.type === 'rate');
    const steady = rates.slice(3);
    const errors = events.filter((e) => ['error', 'start-error', 'decode-error'].includes(e.type));
    const winner = detectors.find((d) => d.pass) || null;

    return {
        meta: trace.meta,
        counts: { events: events.length, blink: blink.length, ear: ear.length, marks: windows.length, errors: errors.length },
        rates: {
            framesSentPerS: median(steady.map((r) => r.sent)),
            framesDroppedPerS: median(steady.map((r) => r.dropped)),
            blinkSamplesPerS: median(steady.map((r) => r.blink)),
        },
        blinkFlagLongestRunS: +Math.max(0, ...blinkRuns.map((r) => r.dur)).toFixed(2),
        detectors,
        validation: validationAnalysis(events, windows),
        errors: errors.slice(0, 20),
        verdict: winner ? `GO — "${winner.name}" passes at a ${winner.bestT} s threshold` : 'NO-GO — no detector met the gate',
    };
}

function printReport(r) {
    const L = [];
    L.push(`Drift M0 report — ${r.meta?.startedAt || ''} — SDK ${r.meta?.sdkVersion || '?'} — face only: ${r.meta?.faceOnly}`);
    L.push(`Events ${r.counts.events} · blink samples ${r.counts.blink} · EAR samples ${r.counts.ear} · test actions ${r.counts.marks} · errors ${r.counts.errors}`);
    L.push(`Median per second: frames sent ${r.rates.framesSentPerS}, dropped ${r.rates.framesDroppedPerS}, blink samples ${r.rates.blinkSamplesPerS}`);
    L.push(`Longest continuous "blink detected" run anywhere: ${r.blinkFlagLongestRunS} s`);
    for (const d of r.detectors) {
        L.push('');
        L.push(`Detector: ${d.name} → ${d.pass ? 'PASS' : 'fail'}`);
        L.push('  closures (asked → measured s): ' + d.perRep.map((p) => `${p.askedS}→${p.measuredS}`).join('  '));
        for (const t of d.byThreshold) {
            L.push(`  T=${t.T}s: 3 s closures caught ${t.hits3}/${t.of3}; false closures in normal watching ${t.fpBaseline}; in notes/phone ${t.fpNotesPhone}`);
        }
    }
    L.push('');
    L.push(`Validation OK during normal watching: ${r.validation.baselineOkShare}`);
    for (const v of r.validation.perRep) {
        L.push(`  ${v.trial} #${v.rep + 1}: target code after ${v.firstTargetAfterS ?? 'never'} s; time share ${JSON.stringify(v.share)}`);
    }
    if (r.errors.length) { L.push(''); L.push('Errors:'); for (const e of r.errors) L.push('  ' + JSON.stringify(e)); }
    L.push('');
    L.push(`VERDICT: ${r.verdict}`);
    return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('analyze.mjs')) {
    const file = process.argv[2];
    if (!file) { console.error('Usage: node analyze.mjs <trace.json> [--json]'); process.exit(2); }
    const report = analyze(JSON.parse(readFileSync(file, 'utf8')));
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : printReport(report));
}
