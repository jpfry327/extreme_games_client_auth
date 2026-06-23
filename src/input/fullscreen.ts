/**
 * Fullscreen + Keyboard Lock.
 *
 * Entering the Fullscreen API alone does NOT stop macOS from stealing
 * Ctrl+Left/Right for Mission Control. The trick browser games use is the
 * Keyboard Lock API (`navigator.keyboard.lock()`), which is only allowed while
 * fullscreen and asks the browser/OS to route even reserved shortcuts to the
 * page instead.
 *
 * Caveats:
 *   - Keyboard Lock is Chromium-only (Chrome / Edge / Arc / Brave). Safari and
 *     Firefox don't support it, so Ctrl will still leak to the OS there.
 *   - Whether it overrides macOS Mission Control specifically is best confirmed
 *     by testing — that's the OS's most stubborn shortcut category.
 *
 * Lock is released automatically by the browser when fullscreen exits.
 */

// navigator.keyboard isn't in the standard TS DOM types yet.
interface KeyboardLock {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}
function keyboardLockApi(): KeyboardLock | null {
  const k = (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;
  return k && typeof k.lock === "function" ? k : null;
}

export function keyboardLockSupported(): boolean {
  return keyboardLockApi() !== null;
}

export async function enterFullscreen(el: HTMLElement = document.documentElement): Promise<void> {
  if (!document.fullscreenElement) {
    await el.requestFullscreen();
  }
  // Lock the keys macOS likes to steal. Passing specific codes is friendlier
  // than locking everything (the browser still lets the user hold Esc to leave).
  await keyboardLockApi()?.lock([
    "ControlLeft",
    "ControlRight",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
  ]);
}

export async function exitFullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen();
}

export async function toggleFullscreen(el?: HTMLElement): Promise<void> {
  if (document.fullscreenElement) await exitFullscreen();
  else await enterFullscreen(el);
}
