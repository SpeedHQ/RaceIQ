import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";

const MAX_BASE_TRACK_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/webp": true, "image/avif": true };

export function TrackBaseImagery({ baseTrackName, imageUrl }: { baseTrackName: string; imageUrl: string | null }) {
  const gameId = useGameId();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    if (!gameId) return;
    if (!SUPPORTED_IMAGE_TYPES[file.type]) {
      setError(m.track_imagery_invalid_file());
      return;
    }
    if (file.size > MAX_BASE_TRACK_IMAGE_BYTES) {
      setError(m.track_imagery_too_large());
      return;
    }

    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);

    try {
      const response = await fetch(`/api/track-base-image?gameId=${encodeURIComponent(gameId)}&baseTrackName=${encodeURIComponent(baseTrackName)}`, {
        method: "POST",
        body: form,
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `Upload failed (${response.status})`);
      await queryClient.invalidateQueries({ queryKey: ["tracks", gameId] });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <Card className="mx-auto w-full max-w-5xl overflow-hidden">
      <CardHeader>
        <CardTitle>{m.track_imagery_title()}</CardTitle>
        <CardDescription>{m.track_imagery_description()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {imageUrl ? (
          <img src={imageUrl} alt={`${baseTrackName} satellite`} className="max-h-[560px] w-full rounded object-contain bg-app-bg" />
        ) : (
          <p className="text-app-subtext text-app-text-dim">{m.track_imagery_empty()}</p>
        )}
        {error && (
          <p role="alert" className="text-app-subtext text-status-danger">
            {error}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="sr-only"
          aria-label={m.track_imagery_upload()}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button variant="app-primary" disabled={uploading || !gameId} onClick={() => inputRef.current?.click()}>
          <Upload data-icon="inline-start" />
          {uploading ? m.track_imagery_uploading() : imageUrl ? m.track_imagery_replace() : m.track_imagery_upload()}
        </Button>
      </CardFooter>
    </Card>
  );
}
