// Eye openness (eye aspect ratio) from SmartSpectra's 478 face landmarks.
// Verified in Milestone 0: the landmarks follow the MediaPipe Face Mesh index
// layout, and this ratio caught 10/10 three-second eye closures.

export interface Point { x?: number | null; y?: number | null }

const RIGHT_EYE = [33, 160, 158, 133, 153, 144] as const;
const LEFT_EYE = [362, 385, 387, 263, 373, 380] as const;

function dist(a: Point, b: Point): number {
    return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));
}

function ratio(points: readonly Point[], idx: readonly number[]): number | null {
    const p = idx.map((i) => points[i]);
    if (p.some((q) => !q)) return null;
    const [p1, p2, p3, p4, p5, p6] = p as [Point, Point, Point, Point, Point, Point];
    const horizontal = dist(p1, p4);
    if (horizontal === 0) return null;
    return (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal);
}

export interface EyeOpenness { left: number; right: number; mean: number }

export function eyeOpenness(points: readonly Point[] | null | undefined): EyeOpenness | null {
    if (!Array.isArray(points) || points.length < 400) return null;
    const right = ratio(points, RIGHT_EYE);
    const left = ratio(points, LEFT_EYE);
    if (right == null || left == null) return null;
    return { left, right, mean: (left + right) / 2 };
}

/**
 * How much the face moved since the previous frame: mean |dx|+|dy| over a spread of
 * landmarks, divided by the distance between the outer eye corners (so it does not
 * depend on resolution or how close you sit). A tracked face always jitters a little;
 * when the face is gone SmartSpectra repeats the last landmarks, so this drops to ~0.
 */
export function landmarkMotion(prev: readonly Point[] | null, cur: readonly Point[]): number {
    if (!prev || prev.length !== cur.length) return Infinity;
    let sum = 0, n = 0;
    for (let i = 0; i < cur.length; i += 7) {
        const a = prev[i], b = cur[i];
        if (!a || !b) continue;
        sum += Math.abs((b.x ?? 0) - (a.x ?? 0)) + Math.abs((b.y ?? 0) - (a.y ?? 0));
        n++;
    }
    const l = cur[33], r = cur[263];
    const scale = l && r ? Math.hypot((l.x ?? 0) - (r.x ?? 0), (l.y ?? 0) - (r.y ?? 0)) : 0;
    if (!n || !scale) return Infinity;
    return sum / n / scale;
}
