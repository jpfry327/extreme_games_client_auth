/**
 * Background-tab timer keep-alive — a requirement of the client-authoritative
 * ("defender authority") relay model.
 *
 * The client runs its ship's *authoritative* self-sim (`net/localSim.ts`). In a
 * hidden tab Chrome **pauses `requestAnimationFrame` entirely** and throttles
 * background timers to ~1Hz — which would freeze that self-sim. And a frozen
 * defender is an *unkillable* ship: no other node may adjudicate its death, so it
 * just floats there until the tab wakes and then eats the whole backlog at once.
 * (That's the exact "ship freezes while backgrounded, then dies on refocus" bug.)
 *
 * Chrome exempts a page that is **playing audio** from background timer
 * throttling, so we keep a single silent oscillator running. With it, the sim's
 * `setTimeout` driver (main.ts, used while hidden since rAF is paused) keeps ~its
 * cadence, so the ship keeps moving, reporting, and dying normally in the
 * background.
 *
 * Best-effort by nature: it must be (re)started from a user gesture (autoplay
 * policy — main.ts kicks it on first keydown), and a hard OS suspend can still
 * stall everything. The server-side "away" despawn (`net/relayHost.ts`) is the
 * safety net for that case.
 */
export class AudioKeepAlive {
  private ctx: AudioContext | null = null;

  /**
   * Start the silent keep-alive, or resume it if the browser suspended the
   * context. Idempotent and cheap — safe to call on every user gesture and on
   * `visibilitychange`. Must run inside a user gesture the first time.
   */
  start(): void {
    if (this.ctx) {
      // Already built — just make sure it's running (the browser can auto-suspend).
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return; // no Web Audio — fall back to throttled timers + server away-despawn

      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // truly silent; the running graph is what defeats throttling
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      ctx.resume().catch(() => {});
      this.ctx = ctx;
    } catch {
      // Web Audio unavailable/blocked — degrade gracefully (see class doc).
    }
  }
}
