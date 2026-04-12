/**
 * AC Evo Process Checker
 *
 * Monitors system for AC Evo process.
 * Emits events when AC Evo is detected or lost.
 */

import { isGameRunning } from "../registry";
import { EventEmitter } from "events";

export class AcEvoProcessChecker extends EventEmitter {
  private _checkTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;

  start(): void {
    if (this._checkTimer) return;

    console.log("[AC Evo ProcessChecker] Started");

    this._checkTimer = setInterval(() => {
      const running = isGameRunning("ac-evo");

      if (running && !this._isRunning) {
        this._isRunning = true;
        this.emit("ac-evo-detected");
        console.log("[AC Evo ProcessChecker] AC Evo process detected");
      } else if (!running && this._isRunning) {
        this._isRunning = false;
        this.emit("ac-evo-lost");
        console.log("[AC Evo ProcessChecker] AC Evo process lost");
      }
    }, 2000);
  }

  stop(): void {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    console.log("[AC Evo ProcessChecker] Stopped");
  }

  isRunning(): boolean {
    return this._isRunning;
  }
}

export const acEvoProcessChecker = new AcEvoProcessChecker();
