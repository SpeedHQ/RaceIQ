/**
 * ACC Process Checker
 *
 * Monitors system for ACC process.
 * Emits events when ACC is detected or lost.
 */

import { isGameRunning } from "../registry";
import { EventEmitter } from "events";

export class AccProcessChecker extends EventEmitter {
  private _checkTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;

  start(): void {
    if (this._checkTimer) return;

    console.log("[ACC ProcessChecker] Started");

    // Check every 2 seconds
    this._checkTimer = setInterval(() => {
      const accRunning = isGameRunning("acc");

      if (accRunning && !this._isRunning) {
        this._isRunning = true;
        this.emit("acc-detected");
        console.log("[ACC ProcessChecker] ACC process detected");
      } else if (!accRunning && this._isRunning) {
        this._isRunning = false;
        this.emit("acc-lost");
        console.log("[ACC ProcessChecker] ACC process lost");
      }
    }, 2000);
  }

  stop(): void {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    console.log("[ACC ProcessChecker] Stopped");
  }

  isRunning(): boolean {
    return this._isRunning;
  }
}

export const accProcessChecker = new AccProcessChecker();
