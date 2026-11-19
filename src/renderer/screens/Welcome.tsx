interface Props { onAccept: () => void; declined: boolean; onDecline: () => void }

export function Welcome({ onAccept, declined, onDecline }: Props) {
    return (
        <div className="column">
            <h1>Drift pauses your lecture when you drift off.</h1>
            <p className="muted">
                If your eyes stay closed or you leave your seat, Drift pauses the video, marks the moment
                and offers to rewind when you are back. It uses your webcam and Presage SmartSpectra.
            </p>

            <div className="blocks">
                <div className="block">
                    <h3>What Drift looks at</h3>
                    <ul>
                        <li>Whether your eyes are open, from points on your face</li>
                        <li>Whether your face is in front of the screen</li>
                    </ul>
                </div>
                <div className="block">
                    <h3>What Drift never does</h3>
                    <ul>
                        <li>Record, save or upload video or photos of you</li>
                        <li>Judge whether you are tired, stressed or unwell. It is not a health or safety tool, and not for driving.</li>
                        <li>Turn the camera on by itself. You start it, and Esc or Stop camera turns it off.</li>
                    </ul>
                </div>
                <div className="block">
                    <h3>What leaves your computer</h3>
                    <ul>
                        <li>Camera frames go only to the Presage SmartSpectra SDK running inside Drift. Drift itself never saves or uploads them.</li>
                        <li>The SDK contacts Presage with your API key to check it and your credits. Presage's optional usage telemetry is turned off.</li>
                        <li>Your API key is stored encrypted on this computer. You can remove it at any time.</li>
                    </ul>
                </div>
            </div>

            <div className="row">
                <button className="btn primary" data-testid="consent-accept" onClick={onAccept}>I understand, continue</button>
                <button className="btn" data-testid="consent-decline" onClick={onDecline}>Not now</button>
            </div>
            {declined && (
                <p className="notice">No problem. Drift needs the camera to notice when you drift, so there is nothing to do without it. You can close this window, or continue whenever you are ready.</p>
            )}
        </div>
    );
}
