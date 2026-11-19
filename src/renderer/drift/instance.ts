import { DriftEngine } from './engine';

/** One engine for the app's lifetime, shared by the player, summary and settings. */
export const engine = new DriftEngine();

/** Where the lecture was, so switching screens doesn't restart it. */
export const playback = { position: 0, rate: 1 };
