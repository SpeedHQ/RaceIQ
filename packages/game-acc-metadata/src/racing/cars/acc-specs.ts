/**
 * ACC car specifications from official documentation (v1.8.12 PDF appendices).
 *
 * - Max RPM: Appendix 7
 * - Max steering angle: Appendix 5
 * - Brake pressure coefficients: Appendix 3
 * - Brake bias offsets: Appendix 4
 * - CarModelId: Appendix 6
 *
 * Keyed by CarModelId (the numeric ID from shared memory / Appendix 6).
 */

export interface AccCarSpecs {
  maxRpm: number;
  maxSteeringAngle: number;            // degrees
  brakePressureCoeffFront: number;
  brakePressureCoeffRear: number;
  brakeBiasOffset: number;
  // Real-world specs (approximate, BOP-regulated in-game)
  hp: number;                           // approximate horsepower
  weightKg: number;                     // approximate dry weight in kg
  engine: string;                       // engine description
  drivetrain: "RWD" | "AWD" | "MR";    // RWD=rear, AWD=all-wheel, MR=mid-rear
}

// Data extracted from ACC Shared Memory Documentation v1.8.12 appendices
export const ACC_CAR_SPECS: Record<number, AccCarSpecs> = {
  // GT3 - 2018
  0:  { maxRpm: 9250, maxSteeringAngle: 400, brakePressureCoeffFront: 7.1497, brakePressureCoeffRear: 6.7715, brakeBiasOffset: -5, hp: 550, weightKg: 1245, engine: "4.0L Flat-6", drivetrain: "RWD" },   // Porsche 991 GT3 R 2018
  1:  { maxRpm: 7500, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -15, hp: 550, weightKg: 1285, engine: "6.3L V8", drivetrain: "RWD" },      // Mercedes-AMG GT3 2015
  2:  { maxRpm: 7300, maxSteeringAngle: 240, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 550, weightKg: 1260, engine: "3.9L Twin-Turbo V8", drivetrain: "RWD" },  // Ferrari 488 GT3 2018
  3:  { maxRpm: 8650, maxSteeringAngle: 360, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -7, hp: 585, weightKg: 1235, engine: "5.2L V10", drivetrain: "RWD" },       // Audi R8 LMS 2015
  4:  { maxRpm: 8650, maxSteeringAngle: 310, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 570, weightKg: 1239, engine: "5.2L V10", drivetrain: "RWD" },      // Lamborghini Huracan GT3 2015
  5:  { maxRpm: 7500, maxSteeringAngle: 320, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 550, weightKg: 1260, engine: "3.8L Twin-Turbo V8", drivetrain: "RWD" },  // McLaren 650S GT3 2015
  6:  { maxRpm: 7500, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -15, hp: 550, weightKg: 1300, engine: "3.8L Twin-Turbo V6", drivetrain: "RWD" },  // Nissan GT-R Nismo GT3 2018
  7:  { maxRpm: 7100, maxSteeringAngle: 283, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -7, hp: 585, weightKg: 1300, engine: "4.4L Twin-Turbo V8", drivetrain: "RWD" },   // BMW M6 GT3 2017
  8:  { maxRpm: 7400, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -7, hp: 550, weightKg: 1300, engine: "4.0L Twin-Turbo V8", drivetrain: "RWD" },   // Bentley Continental GT3 2018
  9:  { maxRpm: 8500, maxSteeringAngle: 400, brakePressureCoeffFront: 7.1497, brakePressureCoeffRear: 6.7715, brakeBiasOffset: -5, hp: 485, weightKg: 1200, engine: "4.0L Flat-6", drivetrain: "RWD" },           // Porsche 991 II GT3 Cup 2017
  10: { maxRpm: 7500, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -15, hp: 550, weightKg: 1300, engine: "3.8L Twin-Turbo V6", drivetrain: "RWD" },  // Nissan GT-R Nismo GT3 2015
  11: { maxRpm: 7400, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -7, hp: 550, weightKg: 1300, engine: "4.0L Twin-Turbo V8", drivetrain: "RWD" },   // Bentley Continental GT3 2015
  12: { maxRpm: 7750, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -7, hp: 550, weightKg: 1245, engine: "6.0L V12", drivetrain: "RWD" },            // Aston Martin V12 Vantage GT3 2013
  13: { maxRpm: 8650, maxSteeringAngle: 310, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 570, weightKg: 1245, engine: "5.2L V10", drivetrain: "RWD" },           // Lamborghini Gallardo G3 Reiter 2017
  14: { maxRpm: 8750, maxSteeringAngle: 360, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -7, hp: 560, weightKg: 1260, engine: "5.0L Supercharged V8", drivetrain: "RWD" }, // Emil Frey Jaguar G3 2012
  15: { maxRpm: 7750, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -7, hp: 540, weightKg: 1300, engine: "5.0L V8", drivetrain: "RWD" },             // Lexus RC F GT3 2016
  17: { maxRpm: 7500, maxSteeringAngle: 310, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -17, hp: 550, weightKg: 1260, engine: "3.5L Twin-Turbo V6", drivetrain: "MR" },   // Honda NSX GT3 2017
  18: { maxRpm: 8650, maxSteeringAngle: 310, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 570, weightKg: 1239, engine: "5.2L V10", drivetrain: "RWD" },           // Lamborghini Huracan ST 2015

  // GT3 - 2019
  16: { maxRpm: 8650, maxSteeringAngle: 310, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 570, weightKg: 1239, engine: "5.2L V10", drivetrain: "RWD" },           // Lamborghini Huracan GT3 Evo 2019
  19: { maxRpm: 8650, maxSteeringAngle: 360, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 585, weightKg: 1225, engine: "5.2L V10", drivetrain: "RWD" },           // Audi R8 LMS Evo 2019
  20: { maxRpm: 7250, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -7, hp: 535, weightKg: 1245, engine: "4.0L Twin-Turbo V8", drivetrain: "RWD" },   // Aston Martin V8 Vantage GT3 2019
  21: { maxRpm: 7650, maxSteeringAngle: 310, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 550, weightKg: 1260, engine: "3.5L Twin-Turbo V6", drivetrain: "MR" },   // Honda NSX GT3 Evo 2019
  22: { maxRpm: 7700, maxSteeringAngle: 240, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -17, hp: 550, weightKg: 1260, engine: "4.0L Twin-Turbo V8", drivetrain: "RWD" },  // McLaren 720S GT3 2019
  23: { maxRpm: 9250, maxSteeringAngle: 400, brakePressureCoeffFront: 7.1497, brakePressureCoeffRear: 6.7715, brakeBiasOffset: -21, hp: 550, weightKg: 1220, engine: "4.0L Flat-6", drivetrain: "RWD" },        // Porsche 911 II GT3 R 2019

  // GT3 - 2020
  24: { maxRpm: 7600, maxSteeringAngle: 240, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -17, hp: 550, weightKg: 1260, engine: "3.9L Twin-Turbo V8", drivetrain: "RWD" },  // Ferrari 488 GT3 Evo 2020
  25: { maxRpm: 7600, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -14, hp: 550, weightKg: 1285, engine: "6.3L V8", drivetrain: "RWD" },            // Mercedes-AMG GT3 Evo 2020

  // GT3 - 2021
  30: { maxRpm: 7000, maxSteeringAngle: 270, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -14, hp: 590, weightKg: 1260, engine: "4.4L Twin-Turbo V8", drivetrain: "RWD" },  // BMW M4 GT3 2021

  // Challengers Pack - 2022
  31: { maxRpm: 8650, maxSteeringAngle: 360, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 585, weightKg: 1225, engine: "5.2L V10", drivetrain: "RWD" },           // Audi R8 LMS Evo II 2022
  26: { maxRpm: 8000, maxSteeringAngle: 240, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 670, weightKg: 1160, engine: "3.9L Twin-Turbo V8", drivetrain: "RWD" },  // Ferrari 488 Challenge Evo 2020
  27: { maxRpm: 7520, maxSteeringAngle: 180, brakePressureCoeffFront: 7.2886, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -17, hp: 365, weightKg: 1300, engine: "3.0L Twin-Turbo I6", drivetrain: "RWD" }, // BMW M2 CS Racing 2020
  28: { maxRpm: 8750, maxSteeringAngle: 270, brakePressureCoeffFront: 7.1497, brakePressureCoeffRear: 6.7715, brakeBiasOffset: -5, hp: 510, weightKg: 1200, engine: "4.0L Flat-6", drivetrain: "RWD" },          // Porsche 992 GT3 Cup 2021
  29: { maxRpm: 8650, maxSteeringAngle: 310, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 620, weightKg: 1239, engine: "5.2L V10", drivetrain: "RWD" },           // Lamborghini Huracan ST Evo2 2021

  // 2023 GT World Challenge Pack + newer DLC
  32: { maxRpm: 7900, maxSteeringAngle: 240, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -14, hp: 600, weightKg: 1260, engine: "3.0L Twin-Turbo V6", drivetrain: "RWD" },   // Ferrari 296 GT3 2023
  33: { maxRpm: 9250, maxSteeringAngle: 400, brakePressureCoeffFront: 7.1497, brakePressureCoeffRear: 6.7715, brakeBiasOffset: -5, hp: 565, weightKg: 1245, engine: "4.0L Flat-6", drivetrain: "RWD" },            // Porsche 992 GT3 R 2023
  34: { maxRpm: 7700, maxSteeringAngle: 240, brakePressureCoeffFront: 7.5980, brakePressureCoeffRear: 7.4855, brakeBiasOffset: -17, hp: 550, weightKg: 1260, engine: "4.0L Twin-Turbo V8", drivetrain: "RWD" },    // McLaren 720S GT3 Evo 2023
  35: { maxRpm: 7900, maxSteeringAngle: 320, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -14, hp: 550, weightKg: 1289, engine: "5.0L V8", drivetrain: "RWD" },               // Ford Mustang GT3 2024
  36: { maxRpm: 7000, maxSteeringAngle: 270, brakePressureCoeffFront: 7.9585, brakePressureCoeffRear: 7.9585, brakeBiasOffset: -14, hp: 590, weightKg: 1260, engine: "4.4L Twin-Turbo V8", drivetrain: "RWD" },    // BMW M4 GT3 Evo 2024

  // GT4
  50: { maxRpm: 6450, maxSteeringAngle: 360, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -15, hp: 300, weightKg: 1130, engine: "1.8L Turbo I4", drivetrain: "MR" },      // Alpine A110 GT4 2018
  51: { maxRpm: 7000, maxSteeringAngle: 320, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -22, hp: 430, weightKg: 1340, engine: "4.0L Twin-Turbo V8", drivetrain: "RWD" },// Aston Martin Vantage AMR GT4 2018
  52: { maxRpm: 8650, maxSteeringAngle: 360, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -20, hp: 495, weightKg: 1310, engine: "5.2L V10", drivetrain: "AWD" },          // Audi R8 LMS GT4 2016
  53: { maxRpm: 7600, maxSteeringAngle: 246, brakePressureCoeffFront: 7.2886, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -15, hp: 431, weightKg: 1380, engine: "3.0L Twin-Turbo I6", drivetrain: "RWD" }, // BMW M4 GT4 2018
  55: { maxRpm: 7500, maxSteeringAngle: 360, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -18, hp: 480, weightKg: 1350, engine: "6.2L V8", drivetrain: "RWD" },           // Chevrolet Camaro GT4.R 2017
  56: { maxRpm: 7200, maxSteeringAngle: 360, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -18, hp: 380, weightKg: 1080, engine: "3.7L V6", drivetrain: "MR" },            // Ginetta G55 GT4 2012
  57: { maxRpm: 6500, maxSteeringAngle: 290, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -20, hp: 360, weightKg: 1000, engine: "2.0L Turbo I4", drivetrain: "MR" },      // KTM X-Bow GT4 2016
  58: { maxRpm: 7000, maxSteeringAngle: 450, brakePressureCoeffFront: 7.7768, brakePressureCoeffRear: 7.6142, brakeBiasOffset: -15, hp: 430, weightKg: 1380, engine: "4.7L V8", drivetrain: "RWD" },             // Maserati MC GT4 2016
  59: { maxRpm: 7600, maxSteeringAngle: 240, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -20, hp: 562, weightKg: 1270, engine: "3.8L Twin-Turbo V8", drivetrain: "RWD" },// McLaren 570S GT4 2016
  60: { maxRpm: 7000, maxSteeringAngle: 246, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -9, hp: 510, weightKg: 1350, engine: "4.0L Twin-Turbo V8", drivetrain: "RWD" }, // Mercedes-AMG GT4 2016
  61: { maxRpm: 7800, maxSteeringAngle: 400, brakePressureCoeffFront: 10.0000, brakePressureCoeffRear: 10.0000, brakeBiasOffset: -20, hp: 425, weightKg: 1320, engine: "4.0L Flat-6", drivetrain: "MR" },        // Porsche 718 Cayman GT4 MR 2019
};

export function getAccCarSpecs(carModelId: number): AccCarSpecs | undefined {
  return ACC_CAR_SPECS[carModelId];
}
