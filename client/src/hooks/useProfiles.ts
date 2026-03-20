// client/src/hooks/useProfiles.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API = "";

export interface Profile {
  id: number;
  name: string;
  createdAt: string;
}

export interface AppSettingsPartial {
  activeProfileId: number | null;
}

async function fetchProfiles(): Promise<Profile[]> {
  const res = await fetch(`${API}/api/profiles`);
  return res.json();
}

async function fetchSettings(): Promise<AppSettingsPartial> {
  const res = await fetch(`${API}/api/settings`);
  return res.json();
}

export function useProfiles() {
  return useQuery({ queryKey: ["profiles"], queryFn: fetchProfiles });
}

export function useActiveProfileId() {
  return useQuery({
    queryKey: ["active-profile"],
    queryFn: fetchSettings,
    select: (s) => s.activeProfileId,
  });
}

export function useSwitchProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (profileId: number) => {
      const res = await fetch(`${API}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProfileId: profileId }),
      });
      if (!res.ok) throw new Error("Failed to switch profile");
      return profileId;
    },
    onSuccess: (profileId) => {
      // Immediately update the cache so the UI switches without waiting for a refetch
      qc.setQueryData(["active-profile"], (old: any) =>
        old ? { ...old, activeProfileId: profileId } : old
      );
      qc.invalidateQueries({ queryKey: ["laps"] });
    },
  });
}

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`${API}/api/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return res.json() as Promise<Profile>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}

export function useRenameProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      await fetch(`${API}/api/profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${API}/api/profiles/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
