/**
 * AC Evo shared memory recorder.
 * Separate singleton from the ACC recorder so recordings don't collide.
 */
import { KunosRecorder } from "../kunos/recorder";

export const acEvoRecorder = new KunosRecorder();
