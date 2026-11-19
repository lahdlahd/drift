import { formatTime, type Drift } from '../drift/engine';

interface Props {
    lectureName: string | null;
    drifts: Drift[];
    onWatchFrom: (t: number) => void;
    onNewLecture: () => void;
    onBack: () => void;
}

const REASON: Record<Drift['reason'], string> = { 'eyes-closed': 'Eyes closed', away: 'Stepped away', 'signal-lost': 'Camera signal lost' };
const ACTION: Record<string, string> = { rewind: 'Rewound', continue: 'Continued', dismiss: 'Dismissed' };

function awayFor(d: Drift): string {
    if (d.returnedT == null) return '—';
    const s = Math.max(0, (d.returnedT - d.onsetT) / 1e6);
    return s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function Summary({ lectureName, drifts, onWatchFrom, onNewLecture, onBack }: Props) {
    const sorted = [...drifts].sort((a, b) => a.onsetVideo - b.onsetVideo);
    return (
        <div className="column">
            <h1 data-testid="summary-title">
                {drifts.length === 0 ? 'No drifts. You followed the whole lecture.' : `You drifted ${drifts.length} time${drifts.length === 1 ? '' : 's'}`}
            </h1>
            {lectureName && <p className="muted">{lectureName}</p>}
            {sorted.length > 0 && (
                <div className="card">
                    <h2>Moments to rewatch</h2>
                    <table>
                        <thead><tr><th>At</th><th>What happened</th><th>Away for</th><th>You chose</th><th /></tr></thead>
                        <tbody>
                            {sorted.map((d) => (
                                <tr key={d.id}>
                                    <td>{formatTime(d.onsetVideo)}</td>
                                    <td>{REASON[d.reason]}</td>
                                    <td>{awayFor(d)}</td>
                                    <td>{d.action ? ACTION[d.action] : '—'}</td>
                                    <td><button className="btn" onClick={() => onWatchFrom(d.rewindTo)}>Watch from {formatTime(d.rewindTo)}</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="hint" style={{ marginTop: 12 }}>This list is kept only while Drift is open. Nothing about your session is saved.</p>
                </div>
            )}
            <div className="row">
                <button className="btn" onClick={onBack}>Back to the lecture</button>
                <button className="btn primary" onClick={onNewLecture}>Open another lecture</button>
            </div>
        </div>
    );
}
