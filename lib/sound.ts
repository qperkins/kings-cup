/**
 * Tiny Web Audio sound kit — no audio files. Browsers only allow audio after a
 * user gesture, so the context is created lazily and resumed on the first tap.
 */

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

const MUTE_KEY = "kings-cup-muted";

let ctx: AudioContext | null = null;
let muted = false;
let mutedLoaded = false;

function loadMuted() {
  if (mutedLoaded) return;
  mutedLoaded = true;
  try {
    muted = localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    /* storage unavailable: stay unmuted */
  }
}

export function isMuted(): boolean {
  loadMuted();
  return muted;
}

export function setMuted(value: boolean) {
  loadMuted();
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Resume the audio context. Call from a user gesture. */
export function unlockAudio() {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume();
}

/** Unlock audio on the first tap/key press. Returns a cleanup function. */
export function installAudioUnlock(): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => unlockAudio();
  window.addEventListener("pointerdown", handler, { once: true });
  window.addEventListener("keydown", handler, { once: true });
  return () => {
    window.removeEventListener("pointerdown", handler);
    window.removeEventListener("keydown", handler);
  };
}

function tone(
  c: AudioContext,
  freq: number,
  start: number,
  duration: number,
  type: OscillatorType = "sine",
  peak = 0.18,
  endFreq?: number,
) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

function play(fn: (c: AudioContext, t: number) => void) {
  loadMuted();
  if (muted) return;
  const c = getCtx();
  if (!c || c.state !== "running") return; // not unlocked yet: stay silent
  fn(c, c.currentTime);
}

/** Two-note "ding-dong" for "it's your turn". */
export function playTurnChime() {
  play((c, t) => {
    tone(c, 880, t, 0.35, "sine");
    tone(c, 1318.5, t + 0.16, 0.5, "sine");
  });
}

/** Short blip when a card is drawn. */
export function playCardSound() {
  play((c, t) => tone(c, 420, t, 0.12, "triangle", 0.12, 260));
}

/** Rising sweep + sparkle for a Royal Mayhem wildcard. */
export function playWildSound() {
  play((c, t) => {
    tone(c, 220, t, 0.45, "sawtooth", 0.08, 880);
    tone(c, 1568, t + 0.4, 0.3, "sine", 0.12);
    tone(c, 2093, t + 0.5, 0.35, "sine", 0.1);
  });
}

/** The page's real title while a "Your turn" flash is showing, so repeat notifications don't
 * mistake the flashed title for the original (which left it stuck after the tab was shown again). */
let titleBeforeFlash: string | null = null;

/** Vibrate and, if the tab is hidden, flash the title until it is focused. */
export function notifyTurnExternally(name?: string) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(200);
    } catch {
      /* ignore */
    }
  }
  if (typeof document === "undefined" || !document.hidden) return;
  if (titleBeforeFlash === null) titleBeforeFlash = document.title;
  document.title = `\u{1F514} Your turn${name ? `, ${name}` : ""}!`;
  const restore = () => {
    if (document.hidden) return;
    if (titleBeforeFlash !== null) document.title = titleBeforeFlash;
    titleBeforeFlash = null;
    document.removeEventListener("visibilitychange", restore);
  };
  document.addEventListener("visibilitychange", restore);
}
