export interface Track {
  ordinal: number;
  name: string;
  srsSlug: string;
}

export const TRACK_MAP: Record<string, Track> = {
  australia: { ordinal: 0, name: "Melbourne Grand Prix Circuit", srsSlug: "australian-gp-setups" },
  china: { ordinal: 2, name: "Shanghai International Circuit", srsSlug: "china-gp-setups" },
  japan: { ordinal: 13, name: "Suzuka International Racing Course", srsSlug: "japanese-gp-setups" },
  bahrain: { ordinal: 3, name: "Bahrain International Circuit", srsSlug: "bahrain-gp-setups" },
  saudi_arabia: { ordinal: 29, name: "Jeddah Corniche Circuit", srsSlug: "saudi-arabian-gp-setups" },
  miami: { ordinal: 30, name: "Miami International Autodrome", srsSlug: "miami-gp-setups" },
  imola: { ordinal: 27, name: "Autodromo Enzo e Dino Ferrari", srsSlug: "imola-gp-setups" },
  monaco: { ordinal: 5, name: "Circuit de Monaco", srsSlug: "monaco-gp-setups" },
  spain: { ordinal: 4, name: "Circuit de Barcelona-Catalunya", srsSlug: "spanish-gp-setups" },
  canada: { ordinal: 6, name: "Circuit Gilles Villeneuve", srsSlug: "canadian-gp-setups" },
  austria: { ordinal: 17, name: "Red Bull Ring", srsSlug: "austrian-gp-setups" },
  silverstone: { ordinal: 7, name: "Silverstone Circuit", srsSlug: "british-gp-setups" },
  spa: { ordinal: 10, name: "Circuit de Spa-Francorchamps", srsSlug: "belgium-gp-setups" },
  hungary: { ordinal: 9, name: "Hungaroring", srsSlug: "hungarian-gp-setups" },
  netherlands: { ordinal: 26, name: "Circuit Zandvoort", srsSlug: "netherlands-gp-setups" },
  monza: { ordinal: 11, name: "Autodromo Nazionale Monza", srsSlug: "italian-gp-setups" },
  azerbaijan: { ordinal: 20, name: "Baku City Circuit", srsSlug: "azerbaijan-gp-setups" },
  singapore: { ordinal: 12, name: "Marina Bay Street Circuit", srsSlug: "singapore-gp-setups" },
  usa: { ordinal: 15, name: "Circuit of the Americas", srsSlug: "united-states-gp-setups" },
  mexico: { ordinal: 19, name: "Autodromo Hermanos Rodriguez", srsSlug: "mexican-gp-setups" },
  brazil: { ordinal: 16, name: "Autodromo Jose Carlos Pace", srsSlug: "brazilian-gp-setups" },
  las_vegas: { ordinal: 31, name: "Las Vegas Street Circuit", srsSlug: "las-vegas-gp-setups" },
  qatar: { ordinal: 32, name: "Lusail International Circuit", srsSlug: "qatar-gp-setups" },
  abudhabi: { ordinal: 14, name: "Yas Marina Circuit", srsSlug: "abu-dhabi-gp-setups" },
};

export type GuideSection = { heading: string; body: string };
export type GuideEntry = { source: string; videoUrl: string; sections: GuideSection[]; setupTips: string; drivingTips: string };
export type SetupRecord = Record<string, unknown>;
export type SrsData = { setups: SetupRecord[]; videoUrl: string; guideUrl: string; trackGuide: GuideSection[]; setupTips: string; drivingTips: string };

export const F1LAPS = "https://www.f1laps.com";
export const SRS = "https://simracingsetup.com";
export const OUT_DIR = "shared/data/tunes/f1-25";
