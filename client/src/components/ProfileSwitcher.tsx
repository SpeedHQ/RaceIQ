// client/src/components/ProfileSwitcher.tsx
import { useState, useRef, useEffect } from "react";
import {
  useProfiles,
  useActiveProfileId,
  useSwitchProfile,
  useCreateProfile,
  useRenameProfile,
  useDeleteProfile,
  type Profile,
} from "../hooks/useProfiles";

export function ProfileSwitcher() {
  const { data: profiles = [] } = useProfiles();
  const { data: activeProfileId } = useActiveProfileId();
  const switchProfile = useSwitchProfile();
  const createProfile = useCreateProfile();
  const renameProfile = useRenameProfile();
  const deleteProfile = useDeleteProfile();

  const [open, setOpen] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameName, setRenameName] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAddingNew(false);
        setRenamingId(null);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  function handleSwitch(p: Profile) {
    switchProfile.mutate(p.id);
    setOpen(false);
  }

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    createProfile.mutate(name, {
      onSuccess: () => {
        setNewName("");
        setAddingNew(false);
      },
    });
  }

  function handleRename(id: number) {
    const name = renameName.trim();
    if (!name) return;
    renameProfile.mutate({ id, name }, {
      onSuccess: () => setRenamingId(null),
    });
  }

  function handleDelete(id: number) {
    if (profiles.length <= 1) return;
    deleteProfile.mutate(id, {
      onSuccess: () => {
        // If we deleted the active profile, switch to first remaining
        if (id === activeProfileId && profiles.length > 1) {
          const next = profiles.find((p) => p.id !== id);
          if (next) switchProfile.mutate(next.id);
        }
      },
    });
  }

  const initial = activeProfile?.name?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Pill trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2 py-1 rounded border border-app-border bg-app-surface hover:bg-app-border transition-colors text-xs"
      >
        <span className="w-5 h-5 rounded-full bg-app-accent flex items-center justify-center text-white font-bold text-[10px]">
          {initial}
        </span>
        <span className="text-app-text-secondary font-medium max-w-[80px] truncate">
          {activeProfile?.name ?? "No profile"}
        </span>
        <span className="text-app-text-muted text-[10px]">▾</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-app-bg border border-app-border rounded shadow-lg z-50">
          <div className="py-1">
            {profiles.map((p) => (
              <div
                key={p.id}
                className={`group flex items-center px-3 py-1.5 text-xs cursor-pointer hover:bg-app-bg ${
                  p.id === activeProfileId ? "text-app-accent font-semibold" : "text-app-text"
                }`}
              >
                {renamingId === p.id ? (
                  <input
                    autoFocus
                    className="flex-1 bg-app-bg border border-app-border rounded px-1 py-0.5 text-xs text-app-text outline-none"
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(p.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => setRenamingId(null)}
                  />
                ) : (
                  <>
                    <span className="flex-1 truncate" onClick={() => handleSwitch(p)}>
                      {p.name}
                    </span>
                    <span className="hidden group-hover:flex gap-1 ml-1">
                      <button
                        className="text-app-text-muted hover:text-app-text px-0.5"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(p.id);
                          setRenameName(p.name);
                        }}
                      >
                        ✎
                      </button>
                      {profiles.length > 1 && (
                        <button
                          className="text-app-text-muted hover:text-red-400 px-0.5"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(p.id);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-app-border py-1 px-3">
            {addingNew ? (
              <input
                autoFocus
                className="w-full bg-app-bg border border-app-border rounded px-1 py-0.5 text-xs text-app-text outline-none"
                placeholder="Profile name..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") { setAddingNew(false); setNewName(""); }
                }}
                onBlur={() => { if (!newName.trim()) setAddingNew(false); }}
              />
            ) : (
              <button
                className="text-xs text-app-text-muted hover:text-app-text"
                onClick={() => setAddingNew(true)}
              >
                + Add profile
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
