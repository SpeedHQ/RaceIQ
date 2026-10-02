export interface CarSpecs {
  hp: number;
  torque: number;
  weightLbs: number;
  weightKg: number;
  displacement: number;
  engine: string;
  drivetrain: string;
  gears: number;
  aspiration: string;
  frontWeightPct: number;
  pi: number;
  speedRating: number;
  brakingRating: number;
  handlingRating: number;
  accelRating: number;
  price: number;
  division: string;
  topSpeedMph: number;
  quarterMile: number;
  zeroToSixty: number;
  zeroToHundred: number;
  braking60: number;
  braking100: number;
  lateralG60: number;
  lateralG120: number;
  imageUrl: string;
  wikiUrl: string;
  synopsis: string;
}

export interface Car {
  ordinal: number;
  name: string;
  specs?: CarSpecs;
}

export type SortKey =
  | "name"
  | "pi"
  | "hp"
  | "torque"
  | "weightKg"
  | "topSpeedMph"
  | "zeroToSixty"
  | "zeroToHundred"
  | "braking60"
  | "speedRating"
  | "brakingRating"
  | "handlingRating"
  | "accelRating"
  | "division";

export type Formatters = {
  fmtSpeed: (mph: number) => string;
  fmtBrake: (ft: number) => string;
  fmtWeight: (kg: number, lbs: number) => string;
};
