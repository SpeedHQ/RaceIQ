export const RECORDING_FREQUENCIES_HZ = [50, 60, 70, 80, 90, 100] as const;
export type RecordingFrequencyHz = (typeof RECORDING_FREQUENCIES_HZ)[number];
export const DEFAULT_RECORDING_FREQUENCY_HZ: RecordingFrequencyHz = 100;

export function isRecordingRetentionPolicyValid(settings: {
  sessionDownsampleEnabled: boolean;
  sessionDownsampleAgeDays: number;
  sessionCleanupEnabled: boolean;
  sessionCleanupAgeDays: number;
}): boolean {
  return !(settings.sessionDownsampleEnabled && settings.sessionCleanupEnabled
    && settings.sessionCleanupAgeDays <= settings.sessionDownsampleAgeDays);
}
