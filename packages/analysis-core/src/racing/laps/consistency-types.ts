export interface CornerLineSpread {
  corner: string;
  lateralSpreadM: number;
  lowTrust: boolean;
}

export interface LineSpreadTrace {
  fracs: number[];
  spreadM: number[];
  perCorner: CornerLineSpread[];
  lowTrust: boolean;
  consistencyScore: number;
  overallSpreadM: number;
  lapCount: number;
}
