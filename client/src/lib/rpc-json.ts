type JsonResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

export async function rpcJson<T>(res: JsonResponse): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}
