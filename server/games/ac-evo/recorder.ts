/**
 * AC Evo shared memory recorder.
 * Separate singleton from the ACC recorder so recordings don't collide.
 */
import { AcRecorder } from "../acc/recorder";

export const acEvoRecorder = new AcRecorder();
