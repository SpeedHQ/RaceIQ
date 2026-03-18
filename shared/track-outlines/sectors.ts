export interface TrackSectors {
  s1End: number; // fraction 0-1 where sector 1 ends
  s2End: number; // fraction 0-1 where sector 2 ends
  // S3 ends at 1.0 (start/finish)
}

const DEFAULT_SECTORS: TrackSectors = { s1End: 0.333, s2End: 0.666 };

// Known FIA/real-world sector boundaries (approximate % of lap distance)
// Sources: FIA timing sheets, circuit maps, broadcast sector splits
const TRACK_SECTORS: Record<string, TrackSectors> = {
  // --- Real-world tracks with known/researched sector boundaries ---

  // Spa: S1 ends after Eau Rouge climb (~2.2km of 7.0km), S2 ends after Stavelot (~4.6km)
  "Circuit de Spa-Francorchamps": { s1End: 0.31, s2End: 0.66 },

  // Silverstone GP: S1 ends after Maggots-Becketts complex (~2.1km of 5.9km), S2 ends after Stowe (~4.0km)
  "Silverstone Racing Circuit": { s1End: 0.35, s2End: 0.68 },

  // Suzuka: S1 ends after Degner curves (~2.1km of 5.8km), S2 ends after Spoon (~4.2km)
  "Suzuka Circuit": { s1End: 0.37, s2End: 0.72 },

  // Laguna Seca: S1 ends after Turn 5 (~1.3km of 3.6km), S2 ends after Corkscrew (~2.5km)
  "WeatherTech Raceway Laguna Seca": { s1End: 0.36, s2End: 0.70 },

  // Barcelona GP: S1 ends after Turn 5 (~1.5km of 4.66km), S2 ends after chicane (~3.1km)
  "Circuit de Barcelona-Catalunya": { s1End: 0.33, s2End: 0.67 },

  // Nurburgring GP: S1 ends after Turn 4 (~1.6km of 5.15km), S2 ends after chicane (~3.4km)
  "Nürburgring": { s1End: 0.31, s2End: 0.66 },

  // Hockenheim: S1 ends after Nordkurve hairpin (~1.5km of 4.57km), S2 ends after Turn 10 (~3.1km)
  "Hockenheimring": { s1End: 0.33, s2End: 0.68 },

  // Yas Marina: S1 ends after Turn 7 (~1.8km of 5.28km), S2 ends after Turn 14 (~3.5km)
  "Yas Marina Circuit": { s1End: 0.34, s2End: 0.67 },

  // Indianapolis road course: S1 ends after Turn 6 (~1.3km of 3.93km), S2 ends after Turn 11 (~2.6km)
  "Indianapolis Motor Speedway": { s1End: 0.33, s2End: 0.66 },

  // Brands Hatch GP: S1 ends after Druids (~1.2km of 3.7km), S2 ends after Stirlings (~2.5km)
  "Brand Hatch": { s1End: 0.32, s2End: 0.67 },

  // Road Atlanta: S1 ends after esses (~1.4km of 4.1km), S2 ends after Turn 10a (~2.7km)
  "Road Atlanta": { s1End: 0.34, s2End: 0.66 },

  // Mugello: S1 ends after Savelli (~1.7km of 5.25km), S2 ends after Correntaio (~3.5km)
  "Mugello Circuit": { s1End: 0.33, s2End: 0.67 },

  // Le Mans: S1 ends after Tertre Rouge (~3.7km of 13.6km), S2 ends after Indianapolis (~8.8km)
  "Le Mans - Circuit International de la Sarthe": { s1End: 0.27, s2End: 0.65 },

  // Mount Panorama: S1 ends at top of mountain (~2.1km of 6.21km), S2 ends after The Chase (~4.1km)
  "Mount Panorama": { s1End: 0.34, s2End: 0.66 },

  // Daytona sports car: S1 ends after bus stop chicane (~1.9km of 5.78km), S2 ends after oval banking (~3.8km)
  "Daytona Intl Speedway": { s1End: 0.33, s2End: 0.66 },

  // Lime Rock: S1 ends after Big Bend (~0.8km of 2.41km), S2 ends after right-hander (~1.6km)
  "Lime Rock Park": { s1End: 0.33, s2End: 0.66 },

  // Sebring: S1 ends after Turn 7 (~2.0km of 6.02km), S2 ends after Turn 13 (~4.0km)
  "Sebring International": { s1End: 0.33, s2End: 0.66 },

  // Watkins Glen: S1 ends after esses (~1.8km of 5.55km), S2 ends after bus stop (~3.7km)
  "Watkins Glen International Speedway": { s1End: 0.33, s2End: 0.67 },

  // Road America: S1 ends after Turn 5 (~2.2km of 6.52km), S2 ends after Turn 11 (~4.3km)
  "Road America": { s1End: 0.34, s2End: 0.66 },

  // Mid-Ohio: S1 ends after keyhole (~1.2km of 3.62km), S2 ends after Turn 9 (~2.4km)
  "Mid-Ohio Sports Car Course": { s1End: 0.33, s2End: 0.66 },

  // Kyalami: S1 ends after Turn 5 (~1.5km of 4.53km), S2 ends after Turn 12 (~3.0km)
  "Kyalami Grand Prix Circuit": { s1End: 0.33, s2End: 0.66 },

  // VIR: S1 ends after Oak Tree (~1.7km of 5.26km), S2 ends after hog pen (~3.5km)
  "Virginia International Raceway": { s1End: 0.33, s2End: 0.66 },

  // Homestead: equal thirds (no standard FIA sectors)
  "Homestead-Miami Speedway": { s1End: 0.333, s2End: 0.666 },
};

// Fictional tracks get default equal thirds
// Fujimi Kaido, Grand Oak Raceway, Hakone, Maple Valley,
// Eaglerock Speedway, Sunset Peninsula Raceway

export function getTrackSectorsByName(trackName: string): TrackSectors {
  return TRACK_SECTORS[trackName] ?? DEFAULT_SECTORS;
}

export { DEFAULT_SECTORS, TRACK_SECTORS };
