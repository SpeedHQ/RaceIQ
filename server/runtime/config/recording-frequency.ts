import { DEFAULT_RECORDING_FREQUENCY_HZ, type RecordingFrequencyHz } from "@raceiq/shared/platform/runtime/recording-frequency";

let recordingFrequencyHz: RecordingFrequencyHz = DEFAULT_RECORDING_FREQUENCY_HZ;

export function getRecordingFrequencyHz(): RecordingFrequencyHz {
  return recordingFrequencyHz;
}

export function setRecordingFrequencyHz(frequencyHz: RecordingFrequencyHz): void {
  recordingFrequencyHz = frequencyHz;
}
