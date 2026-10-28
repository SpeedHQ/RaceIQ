import { client } from "@raceiq/backend-core/db/index";
import { replaceLapsForSession } from "@raceiq/backend-core/db/lap-reprocessing-queries";

export async function commitLapReconciliation(
  sessionId: number,
  replacements: Parameters<typeof replaceLapsForSession>[1],
  identity?: Parameters<typeof replaceLapsForSession>[2],
): Promise<void> {
  const transaction = await client.transaction("write");
  let publish: () => void;
  try {
    publish = await replaceLapsForSession(sessionId, replacements, identity, transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  publish();
}
