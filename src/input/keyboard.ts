import type { InputCommand } from "../sim/types";

/**
 * Tracks which keys are currently held and exposes them as an InputCommand.
 * Controls: arrow keys rotate/thrust, Z (or Ctrl) fires the gun, Tab fires a
 * bomb, Shift is the afterburner.
 *
 * Note on Ctrl: macOS steals Ctrl+Left/Right for Mission Control at the OS level
 * (before the browser sees it), and Ctrl+Tab is reserved by the browser. So we
 * default the gun to Z (bottom-left, near where Ctrl sits) and the bomb to plain
 * Tab — both of which we can reliably capture. Ctrl still works as a gun key for
 * anyone who's disabled the OS shortcuts.
 */
export class Keyboard {
  private held = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      this.held.add(e.code);
      // Stop the browser's default for keys we use: arrows scroll, Space scrolls,
      // Tab moves focus off the canvas.
      if (e.code.startsWith("Arrow") || e.code === "Space" || e.code === "Tab") {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => this.held.delete(e.code));
    // Drop all keys if the window loses focus, so the ship doesn't fly off.
    window.addEventListener("blur", () => this.held.clear());
  }

  sample(): InputCommand {
    return {
      rotateLeft: this.held.has("ArrowLeft"),
      rotateRight: this.held.has("ArrowRight"),
      thrust: this.held.has("ArrowUp"),
      reverse: this.held.has("ArrowDown"),
      afterburner: this.held.has("ShiftLeft") || this.held.has("ShiftRight"),
      fire:
        this.held.has("KeyZ") ||
        this.held.has("ControlLeft") ||
        this.held.has("ControlRight"),
      bomb: this.held.has("Tab"),
    };
  }
}
