export interface F125Setup {
  team: string;
  author: string;
  lapTime: string;
  sessionType: string;
  inputDevice: string;
  weather: string;
  source: string;
  provider: string;
  videoUrl?: string;
  setup: Record<string, number | null>;
}

export interface F125GuideSection {
  heading: string;
  body: string;
}

export interface F125GuideEntry {
  source: string;
  videoUrl: string;
  sections: F125GuideSection[];
  setupTips: string;
  drivingTips: string;
}

export interface F125TrackData {
  trackSlug: string;
  trackName: string;
  trackOrdinal: number;
  trackGuide?: F125GuideEntry[];
  setups: F125Setup[];
}

export interface F125TrackSummary {
  trackSlug: string;
  trackName: string;
  trackOrdinal: number;
  setupCount: number;
}
