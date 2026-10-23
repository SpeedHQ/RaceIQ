import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";

export type RatingStatus = { configured: boolean; connected: boolean; customerId: number | null; displayName: string | null; lastSyncedAt: string | null };
export type RatingHistory = { customerId: number; entries: Array<{ categoryId: number; categoryName: string; observedAt: string; irating: number; change: number | null }>; lastSyncedAt: string | null };

/** Typed client boundary for the agreed /api/iracing-rating contract. */
export const iratingApi = {
  status: () => client.api["iracing-rating"].status.$get().then((response) => rpcJson<RatingStatus>(response)),
  history: () => client.api["iracing-rating"].history.$get().then((response) => rpcJson<RatingHistory>(response)),
  saveClient: (credentials: { clientId: string; clientSecret: string; redirectUri: string }) => client.api["iracing-rating"].client.$put({ json: credentials }).then((response) => rpcJson<{ configured: true }>(response)),
  removeClient: () => client.api["iracing-rating"].client.$delete().then((response) => rpcJson<{ configured: boolean }>(response)),
  sync: () => client.api["iracing-rating"].sync.$post().then((response) => rpcJson<{ imported: number; lastSyncedAt: string }>(response)),
  disconnect: () => client.api["iracing-rating"].connection.$delete().then((response) => rpcJson<{ connected: false }>(response)),
};
