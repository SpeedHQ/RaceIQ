/**
 * AC Evo shared memory recorder.
 * Separate singleton from the ACC recorder so recordings don't collide.
 */
import { KunosRecorder } from "@raceiq/backend-core/games/kunos/recorder";

export const acEvoRecorder = new KunosRecorder();
