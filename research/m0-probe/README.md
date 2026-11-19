# Drift — Milestone 0 signal probe

A small test app that answers one question before Drift is built:
**can SmartSpectra tell when your eyes stay closed for about 3 seconds?**

It shows the live face signals, runs about 12 minutes of guided tests with
beep cues, and saves a log you send back for analysis.

- No video is recorded or saved.
- SDK telemetry is turned off (`enableTelemetry: false`).
- Your API key stays in memory only. It is not saved, and it is not written to the log.
- The SDK still contacts Presage (physiology.presagetech.com) to check the key and credits.

## Run it on Windows 11

Use **Command Prompt** or Windows Terminal. Don't use the VS Code terminal.

```bat
cd %USERPROFILE%\Projects\drift\m0-probe
npm install
npm start
```

`npm install` downloads a few hundred MB: Electron, plus Presage's native runtime for every platform.

## Test steps

1. Sit where you would normally study. Turn on a light in front of you, and close other apps that use the camera.
2. Leave the resolution at **640 × 480** and click **Check camera speed**. You need about 25 frames/s or more. If it is lower, add light in front of you (a lamp or a window, not behind you), plug in the charger, and check again.
3. Paste your Presage API key and click **Start camera**.
4. Check the **Live signals** panel:
   - **Processing** should read `Running`;
   - **Validation** should read `Ok`;
   - **Camera frames / s** and **Frames sent to SDK / s** should both be about 25–30;
   - **Eyes:** should flip to `CLOSED` when you close your eyes.
5. Click **Run all tests in order**. One high beep means do the action. Two low beeps mean return to normal.
   1. Normal watching, 5 min.
   2. Eyes closed 3 s, 10 times.
   3. Eyes closed 2, 4 and 6 s.
   4. Look down at notes, 10 s, 3 times.
   5. Turn to your phone, 10 s, 2 times.
   6. Leave the frame, 10 s, 2 times.
6. Click **Save log**, then **Stop camera**. If the SDK stops with an error, the log is saved automatically.
7. Send the saved `drift-m0-trace-*.json` file back in the chat.

## Analyse a log

```bash
npm run analyze -- path/to/drift-m0-trace.json
```

The gate passes if a 3-second closure is caught at least 9 times out of 10, and 5 minutes of normal watching produce no false closure.

## Developer checks

- `npm test` runs the analyser tests on synthetic traces.
- `DRIFT_PROBE_SELFTEST=1 npm start` runs a headless launch smoke test with a dummy key.
