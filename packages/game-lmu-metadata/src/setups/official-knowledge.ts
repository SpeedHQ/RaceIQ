// Reviewed paraphrases of official LMU documentation, not community tuning rules.
// Keep source review dates attached to facts; do not infer SVM click scales or bounds.
export interface OfficialLmuSource {
  readonly title: string;
  readonly url: string;
  readonly reviewedAt: string;
}

export interface OfficialLmuSetupTopic {
  readonly id: string;
  readonly parameterId: string;
  readonly title: string;
  readonly summary: string;
  readonly facts: readonly string[];
  readonly sources: readonly OfficialLmuSource[];
}

const hypercar: OfficialLmuSource = {
  title: "Hypercar Category (LMH & LMDh)",
  url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152322265231-Hypercar-Category-LMH-LMDh",
  reviewedAt: "2026-10-04",
};
const energy: OfficialLmuSource = {
  title: "What is Virtual Energy? (NRG)",
  url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152376674191-What-is-Virtual-Energy-NRG",
  reviewedAt: "2026-10-04",
};
const abs: OfficialLmuSource = {
  title: "ABS (Anti-Lock Braking System) for LMGT3 Cars",
  url: "https://guide.lemansultimate.com/hc/en-gb/articles/13211078435983-ABS-Anti-Lock-Braking-System-for-LMGT3-Cars",
  reviewedAt: "2026-10-04",
};
const traction: OfficialLmuSource = {
  title: "How do I configure my traction control in Le Mans Ultimate?",
  url: "https://guide.lemansultimate.com/hc/en-gb/articles/13182869047311-How-do-I-configure-my-traction-control-in-Le-Mans-Ultimate",
  reviewedAt: "2026-10-04",
};

export const LMU_OFFICIAL_MOTOR_MAP: OfficialLmuSetupTopic = {
  id: "motor-map",
  parameterId: "motorMap",
  title: "Hybrid deployment and combined power",
  summary: "On hybrid Hypercars, the electric motor map controls battery deployment. The MGU replaces ICE torque under the combined power limit; it does not add extra total power. LMDh deploys through the rear axle; front-hybrid LMH deploys through the front axle above its permitted deployment speed.",
  facts: [
    "A higher electric motor map uses more battery under acceleration, reducing the combustion engine's share of the required output.",
    "All LMDh cars are hybrid. LMH includes both hybrid and non-hybrid cars; non-hybrid LMH has no electric deployment.",
    "Manage battery charge for fuel efficiency and braking effectiveness rather than treating deployment as an extra-power boost.",
  ],
  sources: [hypercar, energy],
};

export const LMU_OFFICIAL_SETUP_KNOWLEDGE: readonly OfficialLmuSetupTopic[] = [
  LMU_OFFICIAL_MOTOR_MAP,
  {
    id: "regeneration",
    parameterId: "regen",
    title: "Regeneration and battery charge",
    summary: "Regenerative braking converts braking energy into battery charge. Battery charge and the Virtual Energy stint allowance are separate quantities.",
    facts: [
      "LMDh uses a rear-axle MGU; hybrid LMH usually uses a front-axle MGU.",
      "A fully charged battery cannot accept regeneration, increasing reliance on friction brakes and their temperatures.",
      "Balance harvest and deployment during the stint. Regeneration refills the battery, not the NRG allowance.",
    ],
    sources: [hypercar, energy],
  },
  {
    id: "virtual-energy",
    parameterId: "virtualEnergy",
    title: "Virtual Energy is a stint allowance",
    summary: "Virtual Energy (NRG) limits combined energy consumption per stint. It is not the hybrid battery's state of charge, and its presence does not establish hybrid capability.",
    facts: [
      "LMGT3 and non-hybrid LMH also use NRG, based on their fuel consumption.",
      "The selected NRG allocation affects pit-stop duration. Monitor the remaining allowance separately from fuel and battery charge.",
      "The reviewed guide specifies a 100-second stop-and-go when NRG reaches zero, with harsher penalties for repeated violations.",
      "Lift-and-coast and short shifting are documented energy-saving techniques.",
    ],
    sources: [energy, hypercar],
  },
  {
    id: "fuel-ratio",
    parameterId: "fuelRatio",
    title: "Fuel carried versus energy allowance",
    summary: "Fuel Ratio determines fuel carried relative to the NRG stint allowance. Carrying extra fuel does not increase that allowance.",
    facts: [
      "Plan fuel and NRG from measured consumption and the in-car displays, rather than confusing either with battery charge.",
      "Hybrid deployment can reduce fuel consumption without increasing combined power output.",
      "Avoid unnecessary fuel weight; preserve enough battery charge for hybrid operation, including LMDh pit-lane power.",
    ],
    sources: [hypercar, energy],
  },
  {
    id: "abs-maps",
    parameterId: "electronics",
    title: "Native ABS and car-specific maps",
    summary: "LMGT3 is the only category with native ABS. Other classes may use a separate driving assist; that is not evidence of native ABS capability.",
    facts: [
      "Since the June 2025 refinement, ABS maps tune particular behaviours rather than representing a simple progression from less to more intervention.",
      "Choose a suitable ABS map before adjusting brake bias; changing the two together can cause instability.",
      "Use the official car-map diagram and in-game behaviour, not an assumed universal one-click ABS direction.",
    ],
    sources: [abs],
  },
  {
    id: "traction-control",
    parameterId: "electronics",
    title: "Three traction-control settings",
    summary: "LMU traction control is managed by the car, not an additional driving assist. Its settings control different aspects of intervention.",
    facts: [
      "Traction Control sets the slip allowed before intervention; Power Cut sets how much power is removed; Slip Angle targets lateral slip before activation.",
      "These controls can be adjusted in the garage's powertrain menu and on track through the MFD electronics menu.",
      "Electric motor map can change the axle torque distribution; assess the actual car rather than assuming one generic TC setting covers every effect.",
    ],
    sources: [traction],
  },
];

export function getOfficialLmuSetupKnowledge(parameterId: string): readonly OfficialLmuSetupTopic[] {
  return LMU_OFFICIAL_SETUP_KNOWLEDGE.filter((topic) => topic.parameterId === parameterId);
}
