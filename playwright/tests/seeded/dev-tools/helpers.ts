import { z } from "zod";

export const RecordingFilesSchema = z.object({
  files: z.array(z.object({ name: z.string() })),
});

export const RecordingPacketsSchema = z.object({
  packets: z.array(z.object({ speed: z.number() })),
});

export const ImportResultSchema = z.object({
  ok: z.boolean(),
  packetCount: z.number(),
  laps: z.array(
    z.object({
      lapId: z.number(),
      sessionId: z.number(),
    }),
  ),
});

export const SessionListSchema = z.array(z.object({ id: z.number() }));
