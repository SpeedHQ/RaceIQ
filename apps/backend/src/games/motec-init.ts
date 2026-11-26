import { createAcEvoMotecTarget } from "@raceiq/game-ac-evo/motec";
import { createAccMotecTarget } from "@raceiq/game-acc/motec";
import { registerMotecTarget } from "@raceiq/backend-core/motec/targets";

let initialised = false;

export function initMotecTargets(): void {
  if (initialised) return;
  initialised = true;
  const acEvo = createAcEvoMotecTarget();
  const acc = createAccMotecTarget();
  registerMotecTarget(acc);
  registerMotecTarget(acEvo);
}
