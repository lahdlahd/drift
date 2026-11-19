# Drift

Drift is a lecture player that pauses when you doze off or step away. If your
eyes stay closed or you leave your seat, it pauses the video, marks the moment
and offers to rewind when you're back. It uses your webcam through
[Presage SmartSpectra](https://smartspectra.presagetech.com/docs/).

> Status: Milestone 3 is done: lecture player, automatic pause, markers, rewind card, summary, Settings, and backup away rules.

## How Drift detects drifting

These rules were measured on real hardware in Milestone 0; see `test/presence.test.ts`.

| Situation | Signal | Default |
| --- | --- | --- |
| Eyes closed | Eye openness from SmartSpectra's 478 face landmarks below 60% of your own open-eye level | 3 s |
| Left your seat | Face landmarks stop changing | 4 s |
| Left your seat (backup) | Face not tracked and the SDK reports `NoFaceFound` or `FaceTooHigh` | 4 s |
| Long look-away | Face not tracked at all, for example checking your phone | 20 s, adjustable or off |
| Glancing at notes | Face not tracked briefly; the SDK reports `FaceTooLow` | Never pauses |

SmartSpectra's own `blinking` flag only pulses for about 0.2 s, so it can't
measure a sustained closure. Its validation status keeps reporting `OK` after
you leave, and reports `FaceTooLow` both when you look down and when you get
up. Drift relies on the landmarks instead. These findings come from recordings
on real hardware, which the unit tests replay; see `test/fixtures`.

## Run it (Windows 11, macOS Apple Silicon, Linux x64)

Requirements: Node.js 20+ (24 LTS recommended) and a Presage API key from
[physiology.presagetech.com](https://physiology.presagetech.com/).

```bat
npm install
npm start
```

Use Command Prompt or Windows Terminal. VS Code's terminal sets
`ELECTRON_RUN_AS_NODE`, which stops Electron from starting.

On first run, Drift:

1. shows what it does with the camera;
2. asks for your key;
3. runs a 20-second camera check.

Then open a lecture (MP4 or WebM) and watch. Keyboard shortcuts:

- **Space**: play or pause, or Continue when the drift card is open.
- **R**: rewind, when the drift card is open.
- **← / →**: skip 5 s.
- **Esc**: stop the camera.

You need light in front of your face. When it's lit from behind, a typical laptop
webcam drops to 15 frames per second and the SDK stops.

## Privacy

- **Camera.** It starts only when you click "Turn on camera". It's visible in the top bar while on. **Esc** or **Stop camera** turns it off.
- **No video stored.** Frames go only to the SmartSpectra SDK running inside Drift. Drift never records, saves or uploads video or images.
- **Face metrics only.** Drift requests only these from the SDK, and turns SDK telemetry off (`enableTelemetry: false`).
- **Presage contact.** The SDK still contacts Presage with your key to check it and your credits.
- **API key.** It's stored encrypted with your operating system's protection (Electron `safeStorage`: DPAPI on Windows). It's never stored in plain text, never bundled in the app, and you can remove it in the app.
- **Settings.** A small `settings.json` in Drift's user-data folder holds your consent, your open-eye level and your preferences.

Drift is a study aid. It is not a medical, fatigue or safety device, and must
not be used while driving.

## Development

```bash
npm run check      # typecheck + unit tests + build
npm test           # unit tests, including a replay of the real M0 hardware run
```

Architecture:
- **`src/main`**: Electron main process. Secure window, camera-only permission, encrypted key store, settings.
- **`src/preload`**: the SDK's bridge plus Drift's narrow `window.drift` bridge.
- **`src/renderer/sensing`**: camera and SDK session, eye openness, and the presence tracker.
- **`src/renderer/drift/engine.ts`**: when to pause, where the drift started, and where to rewind to. Tested by replaying the real hardware run against a simulated lecture.
- **`src/renderer/screens`**: consent, key, camera check, player, summary, and the live-signal view.

The SmartSpectra integration follows Presage's official Electron quickstart.
