import { m } from "@/paraglide/messages";

// Resolve messages at render time so locale changes update every guide section.
export function getLmuGuideContent() {
  return {
    parameters: [
      {
        id: "pressure",
        group: m.lmu_guide_content_reference_parameters_pressure_group(),
        name: m.lmu_guide_content_reference_parameters_pressure_name(),
        upLabel: m.lmu_guide_content_reference_parameters_pressure_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_pressure_downLabel(),
        does: m.lmu_guide_content_reference_parameters_pressure_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_pressure_up_effects_0(),
            m.lmu_guide_content_reference_parameters_pressure_up_effects_1(),
            m.lmu_guide_content_reference_parameters_pressure_up_effects_2(),
            m.lmu_guide_content_reference_parameters_pressure_up_effects_3(),
          ],
          compensations: [
            {
              id: "brakeDucts",
              text: m.lmu_guide_content_reference_parameters_pressure_up_compensations_brakeDucts_text(),
            },
            {
              id: "camber",
              text: m.lmu_guide_content_reference_parameters_pressure_up_compensations_camber_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_pressure_down_effects_0(),
            m.lmu_guide_content_reference_parameters_pressure_down_effects_1(),
            m.lmu_guide_content_reference_parameters_pressure_down_effects_2(),
          ],
          compensations: [
            {
              id: "brakeDucts",
              text: m.lmu_guide_content_reference_parameters_pressure_down_compensations_brakeDucts_text(),
            },
          ],
        },
        linked: [
          {
            id: "brakeDucts",
            reason: m.lmu_guide_content_reference_parameters_pressure_linked_brakeDucts_reason(),
          },
          {
            id: "camber",
            reason: m.lmu_guide_content_reference_parameters_pressure_linked_camber_reason(),
          },
          {
            id: "rideHeightF",
            reason: m.lmu_guide_content_reference_parameters_pressure_linked_rideHeightF_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_pressure_note(),
      },
      {
        id: "camber",
        group: m.lmu_guide_content_reference_parameters_pressure_group(),
        name: m.lmu_guide_content_reference_parameters_camber_name(),
        upLabel: m.lmu_guide_content_reference_parameters_camber_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_camber_downLabel(),
        does: m.lmu_guide_content_reference_parameters_camber_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_camber_up_effects_0(),
            m.lmu_guide_content_reference_parameters_camber_up_effects_1(),
            m.lmu_guide_content_reference_parameters_camber_up_effects_2(),
            m.lmu_guide_content_reference_parameters_camber_up_effects_3(),
          ],
          compensations: [
            {
              id: "pressure",
              text: m.lmu_guide_content_reference_parameters_camber_up_compensations_pressure_text(),
            },
            {
              id: "toe",
              text: m.lmu_guide_content_reference_parameters_camber_up_compensations_toe_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_camber_down_effects_0(),
            m.lmu_guide_content_reference_parameters_camber_down_effects_1(),
            m.lmu_guide_content_reference_parameters_camber_down_effects_2(),
          ],
          compensations: [
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_camber_down_compensations_arbF_text(),
            },
          ],
        },
        linked: [
          {
            id: "pressure",
            reason: m.lmu_guide_content_reference_parameters_camber_linked_pressure_reason(),
          },
          {
            id: "caster",
            reason: m.lmu_guide_content_reference_parameters_camber_linked_caster_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_camber_note(),
      },
      {
        id: "toe",
        group: m.lmu_guide_content_reference_parameters_pressure_group(),
        name: m.lmu_guide_content_reference_parameters_toe_name(),
        upLabel: m.lmu_guide_content_reference_parameters_toe_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_toe_downLabel(),
        does: m.lmu_guide_content_reference_parameters_toe_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_toe_up_effects_0(),
            m.lmu_guide_content_reference_parameters_toe_up_effects_1(),
            m.lmu_guide_content_reference_parameters_toe_up_effects_2(),
            m.lmu_guide_content_reference_parameters_toe_up_effects_3(),
          ],
          compensations: [
            {
              id: "pressure",
              text: m.lmu_guide_content_reference_parameters_toe_up_compensations_pressure_text(),
            },
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_toe_up_compensations_electronics_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_toe_down_effects_0(),
            m.lmu_guide_content_reference_parameters_toe_down_effects_1(),
            m.lmu_guide_content_reference_parameters_toe_down_effects_2(),
          ],
          compensations: [
            {
              id: "caster",
              text: m.lmu_guide_content_reference_parameters_toe_down_compensations_caster_text(),
            },
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_toe_down_compensations_arbF_text(),
            },
          ],
        },
        linked: [
          {
            id: "pressure",
            reason: m.lmu_guide_content_reference_parameters_toe_linked_pressure_reason(),
          },
          {
            id: "caster",
            reason: m.lmu_guide_content_reference_parameters_toe_linked_caster_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_toe_note(),
      },
      {
        id: "caster",
        group: m.lmu_guide_content_reference_parameters_pressure_group(),
        name: m.lmu_guide_content_reference_parameters_caster_name(),
        upLabel: m.lmu_guide_content_reference_parameters_caster_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_caster_downLabel(),
        does: m.lmu_guide_content_reference_parameters_caster_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_caster_up_effects_0(),
            m.lmu_guide_content_reference_parameters_caster_up_effects_1(),
            m.lmu_guide_content_reference_parameters_caster_up_effects_2(),
            m.lmu_guide_content_reference_parameters_caster_up_effects_3(),
          ],
          compensations: [
            {
              id: "camber",
              text: m.lmu_guide_content_reference_parameters_caster_up_compensations_camber_text(),
            },
          ],
        },
        down: {
          effects: [m.lmu_guide_content_reference_parameters_caster_down_effects_0(), m.lmu_guide_content_reference_parameters_caster_down_effects_1()],
          compensations: [
            {
              id: "camber",
              text: m.lmu_guide_content_reference_parameters_caster_down_compensations_camber_text(),
            },
          ],
        },
        linked: [
          {
            id: "camber",
            reason: m.lmu_guide_content_reference_parameters_caster_linked_camber_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_caster_note(),
      },
      {
        id: "rearWing",
        group: m.lmu_guide_content_reference_parameters_rearWing_group(),
        name: m.lmu_guide_content_reference_parameters_rearWing_name(),
        upLabel: m.lmu_guide_content_reference_parameters_rearWing_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_rearWing_downLabel(),
        does: m.lmu_guide_content_reference_parameters_rearWing_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_rearWing_up_effects_0(),
            m.lmu_guide_content_reference_parameters_rearWing_up_effects_1(),
            m.lmu_guide_content_reference_parameters_rearWing_up_effects_2(),
            m.lmu_guide_content_reference_parameters_rearWing_up_effects_3(),
          ],
          compensations: [
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_rearWing_up_compensations_rideHeightF_text(),
            },
            {
              id: "frontSplitter",
              text: m.lmu_guide_content_reference_parameters_rearWing_up_compensations_frontSplitter_text(),
            },
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_rearWing_up_compensations_brakeBias_text(),
            },
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_rearWing_up_compensations_arbF_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_rearWing_down_effects_0(),
            m.lmu_guide_content_reference_parameters_rearWing_down_effects_1(),
            m.lmu_guide_content_reference_parameters_rearWing_down_effects_2(),
            m.lmu_guide_content_reference_parameters_rearWing_down_effects_3(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_rearWing_down_compensations_brakeBias_text(),
            },
            {
              id: "rideHeightR",
              text: m.lmu_guide_content_reference_parameters_rearWing_down_compensations_rideHeightR_text(),
            },
            {
              id: "arbR",
              text: m.lmu_guide_content_reference_parameters_rearWing_down_compensations_arbR_text(),
            },
          ],
        },
        linked: [
          {
            id: "rideHeightF",
            reason: m.lmu_guide_content_reference_parameters_rearWing_linked_rideHeightF_reason(),
          },
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_rearWing_linked_brakeBias_reason(),
          },
          {
            id: "springR",
            reason: m.lmu_guide_content_reference_parameters_rearWing_linked_springR_reason(),
          },
          {
            id: "frontSplitter",
            reason: m.lmu_guide_content_reference_parameters_rearWing_linked_frontSplitter_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_rearWing_note(),
      },
      {
        id: "frontSplitter",
        group: m.lmu_guide_content_reference_parameters_rearWing_group(),
        name: m.lmu_guide_content_reference_parameters_frontSplitter_name(),
        upLabel: m.lmu_guide_content_reference_parameters_frontSplitter_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_frontSplitter_downLabel(),
        does: m.lmu_guide_content_reference_parameters_frontSplitter_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_frontSplitter_up_effects_0(),
            m.lmu_guide_content_reference_parameters_frontSplitter_up_effects_1(),
            m.lmu_guide_content_reference_parameters_frontSplitter_up_effects_2(),
            m.lmu_guide_content_reference_parameters_frontSplitter_up_effects_3(),
          ],
          compensations: [
            {
              id: "rearWing",
              text: m.lmu_guide_content_reference_parameters_frontSplitter_up_compensations_rearWing_text(),
            },
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_frontSplitter_up_compensations_rideHeightF_text(),
            },
          ],
        },
        down: {
          effects: [m.lmu_guide_content_reference_parameters_frontSplitter_down_effects_0(), m.lmu_guide_content_reference_parameters_frontSplitter_down_effects_1()],
          compensations: [
            {
              id: "rearWing",
              text: m.lmu_guide_content_reference_parameters_frontSplitter_down_compensations_rearWing_text(),
            },
          ],
        },
        linked: [
          {
            id: "rearWing",
            reason: m.lmu_guide_content_reference_parameters_frontSplitter_linked_rearWing_reason(),
          },
          {
            id: "rideHeightF",
            reason: m.lmu_guide_content_reference_parameters_frontSplitter_linked_rideHeightF_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_frontSplitter_note(),
      },
      {
        id: "rideHeightF",
        group: m.lmu_guide_content_reference_parameters_rearWing_group(),
        name: m.lmu_guide_content_reference_parameters_rideHeightF_name(),
        upLabel: m.lmu_guide_content_reference_parameters_pressure_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_pressure_downLabel(),
        does: m.lmu_guide_content_reference_parameters_rideHeightF_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_rideHeightF_up_effects_0(),
            m.lmu_guide_content_reference_parameters_rideHeightF_up_effects_1(),
            m.lmu_guide_content_reference_parameters_rideHeightF_up_effects_2(),
          ],
          compensations: [
            {
              id: "rearWing",
              text: m.lmu_guide_content_reference_parameters_rideHeightF_up_compensations_rearWing_text(),
            },
            {
              id: "rideHeightR",
              text: m.lmu_guide_content_reference_parameters_rideHeightF_up_compensations_rideHeightR_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_rideHeightF_down_effects_0(),
            m.lmu_guide_content_reference_parameters_rideHeightF_down_effects_1(),
            m.lmu_guide_content_reference_parameters_rideHeightF_down_effects_2(),
          ],
          compensations: [
            {
              id: "bumpstops",
              text: m.lmu_guide_content_reference_parameters_rideHeightF_down_compensations_bumpstops_text(),
            },
            {
              id: "springF",
              text: m.lmu_guide_content_reference_parameters_rideHeightF_down_compensations_springF_text(),
            },
            {
              id: "rearWing",
              text: m.lmu_guide_content_reference_parameters_rideHeightF_down_compensations_rearWing_text(),
            },
          ],
        },
        linked: [
          {
            id: "bumpstops",
            reason: m.lmu_guide_content_reference_parameters_rideHeightF_linked_bumpstops_reason(),
          },
          {
            id: "frontSplitter",
            reason: m.lmu_guide_content_reference_parameters_rideHeightF_linked_frontSplitter_reason(),
          },
          {
            id: "springF",
            reason: m.lmu_guide_content_reference_parameters_rideHeightF_linked_springF_reason(),
          },
          {
            id: "rearWing",
            reason: m.lmu_guide_content_reference_parameters_rideHeightF_linked_rearWing_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_rideHeightF_note(),
      },
      {
        id: "rideHeightR",
        group: m.lmu_guide_content_reference_parameters_rearWing_group(),
        name: m.lmu_guide_content_reference_parameters_rideHeightR_name(),
        upLabel: m.lmu_guide_content_reference_parameters_pressure_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_pressure_downLabel(),
        does: m.lmu_guide_content_reference_parameters_rideHeightR_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_rideHeightR_up_effects_0(),
            m.lmu_guide_content_reference_parameters_rideHeightR_up_effects_1(),
            m.lmu_guide_content_reference_parameters_rideHeightR_up_effects_2(),
          ],
          compensations: [
            {
              id: "rearWing",
              text: m.lmu_guide_content_reference_parameters_rideHeightR_up_compensations_rearWing_text(),
            },
            {
              id: "springR",
              text: m.lmu_guide_content_reference_parameters_rideHeightR_up_compensations_springR_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_rideHeightR_down_effects_0(),
            m.lmu_guide_content_reference_parameters_rideHeightR_down_effects_1(),
            m.lmu_guide_content_reference_parameters_rideHeightR_down_effects_2(),
          ],
          compensations: [
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_rideHeightR_down_compensations_rideHeightF_text(),
            },
          ],
        },
        linked: [
          {
            id: "rideHeightF",
            reason: m.lmu_guide_content_reference_parameters_rideHeightR_linked_rideHeightF_reason(),
          },
          {
            id: "rearWing",
            reason: m.lmu_guide_content_reference_parameters_rideHeightR_linked_rearWing_reason(),
          },
          {
            id: "springR",
            reason: m.lmu_guide_content_reference_parameters_rideHeightR_linked_springR_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_rideHeightR_note(),
      },
      {
        id: "springF",
        group: m.lmu_guide_content_reference_parameters_springF_group(),
        name: m.lmu_guide_content_reference_parameters_springF_name(),
        upLabel: m.lmu_guide_content_reference_parameters_springF_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_springF_downLabel(),
        does: m.lmu_guide_content_reference_parameters_springF_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_springF_up_effects_0(),
            m.lmu_guide_content_reference_parameters_springF_up_effects_1(),
            m.lmu_guide_content_reference_parameters_springF_up_effects_2(),
            m.lmu_guide_content_reference_parameters_springF_up_effects_3(),
          ],
          compensations: [
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_springF_up_compensations_arbF_text(),
            },
            {
              id: "dampers",
              text: m.lmu_guide_content_reference_parameters_springF_up_compensations_dampers_text(),
            },
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_springF_up_compensations_rideHeightF_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_springF_down_effects_0(),
            m.lmu_guide_content_reference_parameters_springF_down_effects_1(),
            m.lmu_guide_content_reference_parameters_springF_down_effects_2(),
          ],
          compensations: [
            {
              id: "dampers",
              text: m.lmu_guide_content_reference_parameters_springF_down_compensations_dampers_text(),
            },
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_springF_down_compensations_rideHeightF_text(),
            },
          ],
        },
        linked: [
          {
            id: "dampers",
            reason: m.lmu_guide_content_reference_parameters_springF_linked_dampers_reason(),
          },
          {
            id: "bumpstops",
            reason: m.lmu_guide_content_reference_parameters_springF_linked_bumpstops_reason(),
          },
          {
            id: "rideHeightF",
            reason: m.lmu_guide_content_reference_parameters_springF_linked_rideHeightF_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_springF_note(),
      },
      {
        id: "springR",
        group: m.lmu_guide_content_reference_parameters_springF_group(),
        name: m.lmu_guide_content_reference_parameters_springR_name(),
        upLabel: m.lmu_guide_content_reference_parameters_springF_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_springF_downLabel(),
        does: m.lmu_guide_content_reference_parameters_springR_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_springR_up_effects_0(),
            m.lmu_guide_content_reference_parameters_springR_up_effects_1(),
            m.lmu_guide_content_reference_parameters_springR_up_effects_2(),
          ],
          compensations: [
            {
              id: "arbR",
              text: m.lmu_guide_content_reference_parameters_springR_up_compensations_arbR_text(),
            },
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_springR_up_compensations_electronics_text(),
            },
            {
              id: "dampers",
              text: m.lmu_guide_content_reference_parameters_springR_up_compensations_dampers_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_springR_down_effects_0(),
            m.lmu_guide_content_reference_parameters_springR_down_effects_1(),
            m.lmu_guide_content_reference_parameters_springR_down_effects_2(),
          ],
          compensations: [
            {
              id: "dampers",
              text: m.lmu_guide_content_reference_parameters_springR_down_compensations_dampers_text(),
            },
            {
              id: "rideHeightR",
              text: m.lmu_guide_content_reference_parameters_springR_down_compensations_rideHeightR_text(),
            },
          ],
        },
        linked: [
          {
            id: "diffPreload",
            reason: m.lmu_guide_content_reference_parameters_springR_linked_diffPreload_reason(),
          },
          {
            id: "dampers",
            reason: m.lmu_guide_content_reference_parameters_springR_linked_dampers_reason(),
          },
          {
            id: "rideHeightR",
            reason: m.lmu_guide_content_reference_parameters_springR_linked_rideHeightR_reason(),
          },
        ],
        note: "",
      },
      {
        id: "arbF",
        group: m.lmu_guide_content_reference_parameters_springF_group(),
        name: m.lmu_guide_content_reference_parameters_arbF_name(),
        upLabel: m.lmu_guide_content_reference_parameters_springF_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_springF_downLabel(),
        does: m.lmu_guide_content_reference_parameters_arbF_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_arbF_up_effects_0(),
            m.lmu_guide_content_reference_parameters_arbF_up_effects_1(),
            m.lmu_guide_content_reference_parameters_arbF_up_effects_2(),
          ],
          compensations: [
            {
              id: "arbR",
              text: m.lmu_guide_content_reference_parameters_arbF_up_compensations_arbR_text(),
            },
            {
              id: "camber",
              text: m.lmu_guide_content_reference_parameters_arbF_up_compensations_camber_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_arbF_down_effects_0(),
            m.lmu_guide_content_reference_parameters_arbF_down_effects_1(),
            m.lmu_guide_content_reference_parameters_arbF_down_effects_2(),
          ],
          compensations: [
            {
              id: "dampers",
              text: m.lmu_guide_content_reference_parameters_arbF_down_compensations_dampers_text(),
            },
          ],
        },
        linked: [
          {
            id: "arbR",
            reason: m.lmu_guide_content_reference_parameters_arbF_linked_arbR_reason(),
          },
          {
            id: "springF",
            reason: m.lmu_guide_content_reference_parameters_arbF_linked_springF_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_arbF_note(),
      },
      {
        id: "arbR",
        group: m.lmu_guide_content_reference_parameters_springF_group(),
        name: m.lmu_guide_content_reference_parameters_arbR_name(),
        upLabel: m.lmu_guide_content_reference_parameters_springF_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_springF_downLabel(),
        does: m.lmu_guide_content_reference_parameters_arbR_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_arbR_up_effects_0(),
            m.lmu_guide_content_reference_parameters_arbR_up_effects_1(),
            m.lmu_guide_content_reference_parameters_arbR_up_effects_2(),
          ],
          compensations: [
            {
              id: "diffPreload",
              text: m.lmu_guide_content_reference_parameters_arbR_up_compensations_diffPreload_text(),
            },
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_arbR_up_compensations_electronics_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_arbR_down_effects_0(),
            m.lmu_guide_content_reference_parameters_arbR_down_effects_1(),
            m.lmu_guide_content_reference_parameters_arbR_down_effects_2(),
          ],
          compensations: [
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_arbR_down_compensations_arbF_text(),
            },
          ],
        },
        linked: [
          {
            id: "arbF",
            reason: m.lmu_guide_content_reference_parameters_arbR_linked_arbF_reason(),
          },
          {
            id: "diffPreload",
            reason: m.lmu_guide_content_reference_parameters_arbR_linked_diffPreload_reason(),
          },
        ],
        note: "",
      },
      {
        id: "dampers",
        group: m.lmu_guide_content_reference_parameters_springF_group(),
        name: m.lmu_guide_content_reference_parameters_dampers_name(),
        upLabel: m.lmu_guide_content_reference_parameters_springF_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_springF_downLabel(),
        does: m.lmu_guide_content_reference_parameters_dampers_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_dampers_up_effects_0(),
            m.lmu_guide_content_reference_parameters_dampers_up_effects_1(),
            m.lmu_guide_content_reference_parameters_dampers_up_effects_2(),
            m.lmu_guide_content_reference_parameters_dampers_up_effects_3(),
          ],
          compensations: [
            {
              id: "springF",
              text: m.lmu_guide_content_reference_parameters_dampers_up_compensations_springF_text(),
            },
            {
              id: "bumpstops",
              text: m.lmu_guide_content_reference_parameters_dampers_up_compensations_bumpstops_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_dampers_down_effects_0(),
            m.lmu_guide_content_reference_parameters_dampers_down_effects_1(),
            m.lmu_guide_content_reference_parameters_dampers_down_effects_2(),
          ],
          compensations: [
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_dampers_down_compensations_arbF_text(),
            },
          ],
        },
        linked: [
          {
            id: "springF",
            reason: m.lmu_guide_content_reference_parameters_dampers_linked_springF_reason(),
          },
          {
            id: "bumpstops",
            reason: m.lmu_guide_content_reference_parameters_dampers_linked_bumpstops_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_dampers_note(),
      },
      {
        id: "bumpstops",
        group: m.lmu_guide_content_reference_parameters_springF_group(),
        name: m.lmu_guide_content_reference_parameters_bumpstops_name(),
        upLabel: m.lmu_guide_content_reference_parameters_bumpstops_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_bumpstops_downLabel(),
        does: m.lmu_guide_content_reference_parameters_bumpstops_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_bumpstops_up_effects_0(),
            m.lmu_guide_content_reference_parameters_bumpstops_up_effects_1(),
            m.lmu_guide_content_reference_parameters_bumpstops_up_effects_2(),
          ],
          compensations: [
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_bumpstops_up_compensations_rideHeightF_text(),
            },
            {
              id: "springF",
              text: m.lmu_guide_content_reference_parameters_bumpstops_up_compensations_springF_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_bumpstops_down_effects_0(),
            m.lmu_guide_content_reference_parameters_bumpstops_down_effects_1(),
            m.lmu_guide_content_reference_parameters_bumpstops_down_effects_2(),
          ],
          compensations: [
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_bumpstops_down_compensations_rideHeightF_text(),
            },
          ],
        },
        linked: [
          {
            id: "rideHeightF",
            reason: m.lmu_guide_content_reference_parameters_bumpstops_linked_rideHeightF_reason(),
          },
          {
            id: "springF",
            reason: m.lmu_guide_content_reference_parameters_bumpstops_linked_springF_reason(),
          },
          {
            id: "dampers",
            reason: m.lmu_guide_content_reference_parameters_bumpstops_linked_dampers_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_bumpstops_note(),
      },
      {
        id: "brakeBias",
        group: m.lmu_guide_content_reference_parameters_brakeBias_group(),
        name: m.lmu_guide_content_reference_parameters_brakeBias_name(),
        upLabel: m.lmu_guide_content_reference_parameters_brakeBias_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_brakeBias_downLabel(),
        does: m.lmu_guide_content_reference_parameters_brakeBias_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakeBias_up_effects_0(),
            m.lmu_guide_content_reference_parameters_brakeBias_up_effects_1(),
            m.lmu_guide_content_reference_parameters_brakeBias_up_effects_2(),
          ],
          compensations: [
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_brakeBias_up_compensations_electronics_text(),
            },
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_brakeBias_up_compensations_arbF_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakeBias_down_effects_0(),
            m.lmu_guide_content_reference_parameters_brakeBias_down_effects_1(),
            m.lmu_guide_content_reference_parameters_brakeBias_down_effects_2(),
          ],
          compensations: [
            {
              id: "rearWing",
              text: m.lmu_guide_content_reference_parameters_brakeBias_down_compensations_rearWing_text(),
            },
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_brakeBias_down_compensations_electronics_text(),
            },
          ],
        },
        linked: [
          {
            id: "rearWing",
            reason: m.lmu_guide_content_reference_parameters_brakeBias_linked_rearWing_reason(),
          },
          {
            id: "electronics",
            reason: m.lmu_guide_content_reference_parameters_brakeBias_linked_electronics_reason(),
          },
          {
            id: "diffPreload",
            reason: m.lmu_guide_content_reference_parameters_brakeBias_linked_diffPreload_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_brakeBias_note(),
      },
      {
        id: "brakePressure",
        group: m.lmu_guide_content_reference_parameters_brakeBias_group(),
        name: m.lmu_guide_content_reference_parameters_brakePressure_name(),
        upLabel: m.lmu_guide_content_reference_parameters_brakePressure_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_pressure_downLabel(),
        does: m.lmu_guide_content_reference_parameters_brakePressure_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakePressure_up_effects_0(),
            m.lmu_guide_content_reference_parameters_brakePressure_up_effects_1(),
            m.lmu_guide_content_reference_parameters_brakePressure_up_effects_2(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_brakePressure_up_compensations_brakeBias_text(),
            },
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_brakePressure_up_compensations_electronics_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakePressure_down_effects_0(),
            m.lmu_guide_content_reference_parameters_brakePressure_down_effects_1(),
            m.lmu_guide_content_reference_parameters_brakePressure_down_effects_2(),
          ],
          compensations: [
            {
              id: "brakeMigration",
              text: m.lmu_guide_content_reference_parameters_brakePressure_down_compensations_brakeMigration_text(),
            },
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_brakePressure_down_compensations_brakeBias_text(),
            },
          ],
        },
        linked: [
          {
            id: "electronics",
            reason: m.lmu_guide_content_reference_parameters_brakePressure_linked_electronics_reason(),
          },
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_brakePressure_linked_brakeBias_reason(),
          },
          {
            id: "brakeMigration",
            reason: m.lmu_guide_content_reference_parameters_brakePressure_linked_brakeMigration_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_brakePressure_note(),
      },
      {
        id: "brakeDucts",
        group: m.lmu_guide_content_reference_parameters_brakeBias_group(),
        name: m.lmu_guide_content_reference_parameters_brakeDucts_name(),
        upLabel: m.lmu_guide_content_reference_parameters_brakeDucts_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_brakeDucts_downLabel(),
        does: m.lmu_guide_content_reference_parameters_brakeDucts_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakeDucts_up_effects_0(),
            m.lmu_guide_content_reference_parameters_brakeDucts_up_effects_1(),
            m.lmu_guide_content_reference_parameters_brakeDucts_up_effects_2(),
          ],
          compensations: [
            {
              id: "pressure",
              text: m.lmu_guide_content_reference_parameters_brakeDucts_up_compensations_pressure_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakeDucts_down_effects_0(),
            m.lmu_guide_content_reference_parameters_brakeDucts_down_effects_1(),
            m.lmu_guide_content_reference_parameters_brakeDucts_down_effects_2(),
          ],
          compensations: [
            {
              id: "pressure",
              text: m.lmu_guide_content_reference_parameters_brakeDucts_down_compensations_pressure_text(),
            },
          ],
        },
        linked: [
          {
            id: "pressure",
            reason: m.lmu_guide_content_reference_parameters_brakeDucts_linked_pressure_reason(),
          },
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_brakeDucts_linked_brakeBias_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_brakeDucts_note(),
      },
      {
        id: "diffPreload",
        group: m.lmu_guide_content_reference_parameters_diffPreload_group(),
        name: m.lmu_guide_content_reference_parameters_diffPreload_name(),
        upLabel: m.lmu_guide_content_reference_parameters_caster_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_caster_downLabel(),
        does: m.lmu_guide_content_reference_parameters_diffPreload_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_diffPreload_up_effects_0(),
            m.lmu_guide_content_reference_parameters_diffPreload_up_effects_1(),
            m.lmu_guide_content_reference_parameters_diffPreload_up_effects_2(),
            m.lmu_guide_content_reference_parameters_diffPreload_up_effects_3(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_diffPreload_up_compensations_brakeBias_text(),
            },
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_diffPreload_up_compensations_arbF_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_diffPreload_down_effects_0(),
            m.lmu_guide_content_reference_parameters_diffPreload_down_effects_1(),
            m.lmu_guide_content_reference_parameters_diffPreload_down_effects_2(),
          ],
          compensations: [
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_diffPreload_down_compensations_electronics_text(),
            },
            {
              id: "springR",
              text: m.lmu_guide_content_reference_parameters_diffPreload_down_compensations_springR_text(),
            },
          ],
        },
        linked: [
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_diffPreload_linked_brakeBias_reason(),
          },
          {
            id: "electronics",
            reason: m.lmu_guide_content_reference_parameters_diffPreload_linked_electronics_reason(),
          },
          {
            id: "arbR",
            reason: m.lmu_guide_content_reference_parameters_diffPreload_linked_arbR_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_diffPreload_note(),
      },
      {
        id: "diffPower",
        group: m.lmu_guide_content_reference_parameters_diffPreload_group(),
        name: m.lmu_guide_content_reference_parameters_diffPower_name(),
        upLabel: m.lmu_guide_content_reference_parameters_diffPower_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_diffPower_downLabel(),
        does: m.lmu_guide_content_reference_parameters_diffPower_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_diffPower_up_effects_0(),
            m.lmu_guide_content_reference_parameters_diffPower_up_effects_1(),
            m.lmu_guide_content_reference_parameters_diffPower_up_effects_2(),
            m.lmu_guide_content_reference_parameters_diffPower_up_effects_3(),
          ],
          compensations: [
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_diffPower_up_compensations_electronics_text(),
            },
            {
              id: "springR",
              text: m.lmu_guide_content_reference_parameters_diffPower_up_compensations_springR_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_diffPower_down_effects_0(),
            m.lmu_guide_content_reference_parameters_diffPower_down_effects_1(),
            m.lmu_guide_content_reference_parameters_diffPower_down_effects_2(),
          ],
          compensations: [
            {
              id: "diffPreload",
              text: m.lmu_guide_content_reference_parameters_diffPower_down_compensations_diffPreload_text(),
            },
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_diffPower_down_compensations_arbF_text(),
            },
          ],
        },
        linked: [
          {
            id: "diffPreload",
            reason: m.lmu_guide_content_reference_parameters_diffPower_linked_diffPreload_reason(),
          },
          {
            id: "electronics",
            reason: m.lmu_guide_content_reference_parameters_diffPower_linked_electronics_reason(),
          },
          {
            id: "diffCoast",
            reason: m.lmu_guide_content_reference_parameters_diffPower_linked_diffCoast_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_diffPower_note(),
      },
      {
        id: "diffCoast",
        group: m.lmu_guide_content_reference_parameters_diffPreload_group(),
        name: m.lmu_guide_content_reference_parameters_diffCoast_name(),
        upLabel: m.lmu_guide_content_reference_parameters_diffPower_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_diffPower_downLabel(),
        does: m.lmu_guide_content_reference_parameters_diffCoast_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_diffCoast_up_effects_0(),
            m.lmu_guide_content_reference_parameters_diffCoast_up_effects_1(),
            m.lmu_guide_content_reference_parameters_diffCoast_up_effects_2(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_diffCoast_up_compensations_brakeBias_text(),
            },
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_diffCoast_up_compensations_arbF_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_diffCoast_down_effects_0(),
            m.lmu_guide_content_reference_parameters_diffCoast_down_effects_1(),
            m.lmu_guide_content_reference_parameters_diffCoast_down_effects_2(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_diffCoast_down_compensations_brakeBias_text(),
            },
            {
              id: "brakeMigration",
              text: m.lmu_guide_content_reference_parameters_diffCoast_down_compensations_brakeMigration_text(),
            },
          ],
        },
        linked: [
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_diffCoast_linked_brakeBias_reason(),
          },
          {
            id: "diffPreload",
            reason: m.lmu_guide_content_reference_parameters_diffCoast_linked_diffPreload_reason(),
          },
          {
            id: "diffPower",
            reason: m.lmu_guide_content_reference_parameters_diffCoast_linked_diffPower_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_diffCoast_note(),
      },
      {
        id: "electronics",
        group: m.lmu_guide_content_reference_parameters_diffPreload_group(),
        name: m.lmu_guide_content_reference_parameters_electronics_name(),
        upLabel: m.lmu_guide_content_reference_parameters_electronics_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_electronics_downLabel(),
        does: m.lmu_guide_content_reference_parameters_electronics_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_electronics_up_effects_0(),
            m.lmu_guide_content_reference_parameters_electronics_up_effects_1(),
            m.lmu_guide_content_reference_parameters_electronics_up_effects_2(),
            m.lmu_guide_content_reference_parameters_electronics_up_effects_3(),
          ],
          compensations: [
            {
              id: "diffPreload",
              text: m.lmu_guide_content_reference_parameters_electronics_up_compensations_diffPreload_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_electronics_down_effects_0(),
            m.lmu_guide_content_reference_parameters_electronics_down_effects_1(),
            m.lmu_guide_content_reference_parameters_electronics_down_effects_2(),
          ],
          compensations: [
            {
              id: "springR",
              text: m.lmu_guide_content_reference_parameters_electronics_down_compensations_springR_text(),
            },
            {
              id: "toe",
              text: m.lmu_guide_content_reference_parameters_electronics_down_compensations_toe_text(),
            },
          ],
        },
        linked: [
          {
            id: "diffPreload",
            reason: m.lmu_guide_content_reference_parameters_electronics_linked_diffPreload_reason(),
          },
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_electronics_linked_brakeBias_reason(),
          },
          {
            id: "pressure",
            reason: m.lmu_guide_content_reference_parameters_electronics_linked_pressure_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_electronics_note(),
      },
      {
        id: "virtualEnergy",
        group: m.lmu_guide_content_reference_parameters_virtualEnergy_group(),
        name: m.lmu_guide_content_reference_parameters_virtualEnergy_name(),
        upLabel: m.lmu_guide_content_reference_parameters_virtualEnergy_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_virtualEnergy_downLabel(),
        does: m.lmu_guide_content_reference_parameters_virtualEnergy_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_virtualEnergy_up_effects_0(),
            m.lmu_guide_content_reference_parameters_virtualEnergy_up_effects_1(),
            m.lmu_guide_content_reference_parameters_virtualEnergy_up_effects_2(),
          ],
          compensations: [
            {
              id: "fuelRatio",
              text: m.lmu_guide_content_reference_parameters_virtualEnergy_up_compensations_fuelRatio_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_virtualEnergy_down_effects_0(),
            m.lmu_guide_content_reference_parameters_virtualEnergy_down_effects_1(),
            m.lmu_guide_content_reference_parameters_virtualEnergy_down_effects_2(),
          ],
          compensations: [
            {
              id: "fuelRatio",
              text: m.lmu_guide_content_reference_parameters_virtualEnergy_down_compensations_fuelRatio_text(),
            },
          ],
        },
        linked: [
          {
            id: "fuelRatio",
            reason: m.lmu_guide_content_reference_parameters_virtualEnergy_linked_fuelRatio_reason(),
          },
          {
            id: "regen",
            reason: m.lmu_guide_content_reference_parameters_virtualEnergy_linked_regen_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_virtualEnergy_note(),
      },
      {
        id: "fuelRatio",
        group: m.lmu_guide_content_reference_parameters_virtualEnergy_group(),
        name: m.lmu_guide_content_reference_parameters_fuelRatio_name(),
        upLabel: m.lmu_guide_content_reference_parameters_fuelRatio_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_fuelRatio_downLabel(),
        does: m.lmu_guide_content_reference_parameters_fuelRatio_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_fuelRatio_up_effects_0(),
            m.lmu_guide_content_reference_parameters_fuelRatio_up_effects_1(),
            m.lmu_guide_content_reference_parameters_fuelRatio_up_effects_2(),
          ],
          compensations: [
            {
              id: "virtualEnergy",
              text: m.lmu_guide_content_reference_parameters_fuelRatio_up_compensations_virtualEnergy_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_fuelRatio_down_effects_0(),
            m.lmu_guide_content_reference_parameters_fuelRatio_down_effects_1(),
            m.lmu_guide_content_reference_parameters_fuelRatio_down_effects_2(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_fuelRatio_down_compensations_brakeBias_text(),
            },
          ],
        },
        linked: [
          {
            id: "virtualEnergy",
            reason: m.lmu_guide_content_reference_parameters_fuelRatio_linked_virtualEnergy_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_fuelRatio_note(),
      },
      {
        id: "regen",
        group: m.lmu_guide_content_reference_parameters_virtualEnergy_group(),
        name: m.lmu_guide_content_reference_parameters_regen_name(),
        upLabel: m.lmu_guide_content_reference_parameters_regen_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_regen_downLabel(),
        does: m.lmu_guide_content_reference_parameters_regen_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_regen_up_effects_0(),
            m.lmu_guide_content_reference_parameters_regen_up_effects_1(),
            m.lmu_guide_content_reference_parameters_regen_up_effects_2(),
            m.lmu_guide_content_reference_parameters_regen_up_effects_3(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_regen_up_compensations_brakeBias_text(),
            },
            {
              id: "motorMap",
              text: m.lmu_guide_content_reference_parameters_regen_up_compensations_motorMap_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_regen_down_effects_0(),
            m.lmu_guide_content_reference_parameters_regen_down_effects_1(),
            m.lmu_guide_content_reference_parameters_regen_down_effects_2(),
          ],
          compensations: [
            {
              id: "virtualEnergy",
              text: m.lmu_guide_content_reference_parameters_regen_down_compensations_virtualEnergy_text(),
            },
          ],
        },
        linked: [
          {
            id: "motorMap",
            reason: m.lmu_guide_content_reference_parameters_regen_linked_motorMap_reason(),
          },
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_regen_linked_brakeBias_reason(),
          },
          {
            id: "virtualEnergy",
            reason: m.lmu_guide_content_reference_parameters_regen_linked_virtualEnergy_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_regen_note(),
      },
      {
        id: "motorMap",
        group: m.lmu_guide_content_reference_parameters_virtualEnergy_group(),
        name: m.lmu_guide_content_reference_parameters_motorMap_name(),
        upLabel: m.lmu_guide_content_reference_parameters_motorMap_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_motorMap_downLabel(),
        does: m.lmu_guide_content_reference_parameters_motorMap_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_motorMap_up_effects_0(),
            m.lmu_guide_content_reference_parameters_motorMap_up_effects_1(),
            m.lmu_guide_content_reference_parameters_motorMap_up_effects_2(),
            m.lmu_guide_content_reference_parameters_motorMap_up_effects_3(),
          ],
          compensations: [
            {
              id: "regen",
              text: m.lmu_guide_content_reference_parameters_motorMap_up_compensations_regen_text(),
            },
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_motorMap_up_compensations_electronics_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_motorMap_down_effects_0(),
            m.lmu_guide_content_reference_parameters_motorMap_down_effects_1(),
            m.lmu_guide_content_reference_parameters_motorMap_down_effects_2(),
          ],
          compensations: [
            {
              id: "regen",
              text: m.lmu_guide_content_reference_parameters_motorMap_down_compensations_regen_text(),
            },
          ],
        },
        linked: [
          {
            id: "regen",
            reason: m.lmu_guide_content_reference_parameters_motorMap_linked_regen_reason(),
          },
          {
            id: "virtualEnergy",
            reason: m.lmu_guide_content_reference_parameters_motorMap_linked_virtualEnergy_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_motorMap_note(),
      },
      {
        id: "frontDiff",
        group: m.lmu_guide_content_reference_parameters_diffPreload_group(),
        name: m.lmu_guide_content_reference_parameters_frontDiff_name(),
        upLabel: m.lmu_guide_content_reference_parameters_diffPower_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_diffPower_downLabel(),
        does: m.lmu_guide_content_reference_parameters_frontDiff_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_frontDiff_up_effects_0(),
            m.lmu_guide_content_reference_parameters_frontDiff_up_effects_1(),
            m.lmu_guide_content_reference_parameters_frontDiff_up_effects_2(),
          ],
          compensations: [
            {
              id: "arbF",
              text: m.lmu_guide_content_reference_parameters_frontDiff_up_compensations_arbF_text(),
            },
            {
              id: "motorMap",
              text: m.lmu_guide_content_reference_parameters_frontDiff_up_compensations_motorMap_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_frontDiff_down_effects_0(),
            m.lmu_guide_content_reference_parameters_frontDiff_down_effects_1(),
            m.lmu_guide_content_reference_parameters_frontDiff_down_effects_2(),
          ],
          compensations: [
            {
              id: "electronics",
              text: m.lmu_guide_content_reference_parameters_frontDiff_down_compensations_electronics_text(),
            },
          ],
        },
        linked: [
          {
            id: "diffPreload",
            reason: m.lmu_guide_content_reference_parameters_frontDiff_linked_diffPreload_reason(),
          },
          {
            id: "motorMap",
            reason: m.lmu_guide_content_reference_parameters_frontDiff_linked_motorMap_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_frontDiff_note(),
      },
      {
        id: "brakeMigration",
        group: m.lmu_guide_content_reference_parameters_brakeBias_group(),
        name: m.lmu_guide_content_reference_parameters_brakeMigration_name(),
        upLabel: m.lmu_guide_content_reference_parameters_brakeMigration_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_brakeMigration_downLabel(),
        does: m.lmu_guide_content_reference_parameters_brakeMigration_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakeMigration_up_effects_0(),
            m.lmu_guide_content_reference_parameters_brakeMigration_up_effects_1(),
            m.lmu_guide_content_reference_parameters_brakeMigration_up_effects_2(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_brakeMigration_up_compensations_brakeBias_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_brakeMigration_down_effects_0(),
            m.lmu_guide_content_reference_parameters_brakeMigration_down_effects_1(),
            m.lmu_guide_content_reference_parameters_brakeMigration_down_effects_2(),
          ],
          compensations: [
            {
              id: "brakeBias",
              text: m.lmu_guide_content_reference_parameters_brakeMigration_down_compensations_brakeBias_text(),
            },
          ],
        },
        linked: [
          {
            id: "brakeBias",
            reason: m.lmu_guide_content_reference_parameters_brakeMigration_linked_brakeBias_reason(),
          },
          {
            id: "electronics",
            reason: m.lmu_guide_content_reference_parameters_brakeMigration_linked_electronics_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_brakeMigration_note(),
      },
      {
        id: "thirdSpring",
        group: m.lmu_guide_content_reference_parameters_springF_group(),
        name: m.lmu_guide_content_reference_parameters_thirdSpring_name(),
        upLabel: m.lmu_guide_content_reference_parameters_springF_upLabel(),
        downLabel: m.lmu_guide_content_reference_parameters_springF_downLabel(),
        does: m.lmu_guide_content_reference_parameters_thirdSpring_does(),
        up: {
          effects: [
            m.lmu_guide_content_reference_parameters_thirdSpring_up_effects_0(),
            m.lmu_guide_content_reference_parameters_thirdSpring_up_effects_1(),
            m.lmu_guide_content_reference_parameters_thirdSpring_up_effects_2(),
          ],
          compensations: [
            {
              id: "springF",
              text: m.lmu_guide_content_reference_parameters_thirdSpring_up_compensations_springF_text(),
            },
            {
              id: "bumpstops",
              text: m.lmu_guide_content_reference_parameters_thirdSpring_up_compensations_bumpstops_text(),
            },
          ],
        },
        down: {
          effects: [
            m.lmu_guide_content_reference_parameters_thirdSpring_down_effects_0(),
            m.lmu_guide_content_reference_parameters_thirdSpring_down_effects_1(),
            m.lmu_guide_content_reference_parameters_thirdSpring_down_effects_2(),
          ],
          compensations: [
            {
              id: "rideHeightF",
              text: m.lmu_guide_content_reference_parameters_thirdSpring_down_compensations_rideHeightF_text(),
            },
          ],
        },
        linked: [
          {
            id: "springF",
            reason: m.lmu_guide_content_reference_parameters_thirdSpring_linked_springF_reason(),
          },
          {
            id: "bumpstops",
            reason: m.lmu_guide_content_reference_parameters_thirdSpring_linked_bumpstops_reason(),
          },
          {
            id: "rideHeightF",
            reason: m.lmu_guide_content_reference_parameters_thirdSpring_linked_rideHeightF_reason(),
          },
        ],
        note: m.lmu_guide_content_reference_parameters_thirdSpring_note(),
      },
    ],
    symptoms: [
      {
        id: "entryUnder",
        group: m.lmu_guide_content_reference_symptoms_entryUnder_group(),
        name: m.lmu_guide_content_reference_symptoms_entryUnder_name(),
        description: m.lmu_guide_content_reference_symptoms_entryUnder_description(),
        quick: m.lmu_guide_content_reference_symptoms_entryUnder_quick(),
        causes: [
          {
            id: "brakeBias",
            label: m.lmu_guide_content_reference_symptoms_entryUnder_causes_brakeBias_label(),
            fix: m.lmu_guide_content_reference_symptoms_entryUnder_causes_brakeBias_fix(),
          },
          {
            id: "diffPreload",
            label: m.lmu_guide_content_reference_symptoms_entryUnder_causes_diffPreload_label(),
            fix: m.lmu_guide_content_reference_symptoms_entryUnder_causes_diffPreload_fix(),
          },
          {
            id: "dampers",
            label: m.lmu_guide_content_reference_symptoms_entryUnder_causes_dampers_label(),
            fix: m.lmu_guide_content_reference_symptoms_entryUnder_causes_dampers_fix(),
          },
          {
            id: "arbF",
            label: m.lmu_guide_content_reference_symptoms_entryUnder_causes_arbF_label(),
            fix: m.lmu_guide_content_reference_symptoms_entryUnder_causes_arbF_fix(),
          },
          {
            id: "pressure",
            label: m.lmu_guide_content_reference_symptoms_entryUnder_causes_pressure_label(),
            fix: m.lmu_guide_content_reference_symptoms_entryUnder_causes_pressure_fix(),
          },
        ],
      },
      {
        id: "entrySnap",
        group: m.lmu_guide_content_reference_symptoms_entryUnder_group(),
        name: m.lmu_guide_content_reference_symptoms_entrySnap_name(),
        description: m.lmu_guide_content_reference_symptoms_entrySnap_description(),
        quick: m.lmu_guide_content_reference_symptoms_entrySnap_quick(),
        causes: [
          {
            id: "brakeBias",
            label: m.lmu_guide_content_reference_symptoms_entrySnap_causes_brakeBias_label(),
            fix: m.lmu_guide_content_reference_symptoms_entrySnap_causes_brakeBias_fix(),
          },
          {
            id: "regen",
            label: m.lmu_guide_content_reference_symptoms_entrySnap_causes_regen_label(),
            fix: m.lmu_guide_content_reference_symptoms_entrySnap_causes_regen_fix(),
          },
          {
            id: "diffPreload",
            label: m.lmu_guide_content_reference_symptoms_entrySnap_causes_diffPreload_label(),
            fix: m.lmu_guide_content_reference_symptoms_entrySnap_causes_diffPreload_fix(),
          },
          {
            id: "rearWing",
            label: m.lmu_guide_content_reference_symptoms_entrySnap_causes_rearWing_label(),
            fix: m.lmu_guide_content_reference_symptoms_entrySnap_causes_rearWing_fix(),
          },
          {
            id: "pressure",
            label: m.lmu_guide_content_reference_symptoms_entrySnap_causes_pressure_label(),
            fix: m.lmu_guide_content_reference_symptoms_entrySnap_causes_pressure_fix(),
          },
          {
            id: "dampers",
            label: m.lmu_guide_content_reference_symptoms_entrySnap_causes_dampers_label(),
            fix: m.lmu_guide_content_reference_symptoms_entrySnap_causes_dampers_fix(),
          },
        ],
      },
      {
        id: "midUnder",
        group: m.lmu_guide_content_reference_symptoms_midUnder_group(),
        name: m.lmu_guide_content_reference_symptoms_midUnder_name(),
        description: m.lmu_guide_content_reference_symptoms_midUnder_description(),
        quick: m.lmu_guide_content_reference_symptoms_midUnder_quick(),
        causes: [
          {
            id: "arbF",
            label: m.lmu_guide_content_reference_symptoms_entryUnder_causes_arbF_label(),
            fix: m.lmu_guide_content_reference_symptoms_midUnder_causes_arbF_fix(),
          },
          {
            id: "camber",
            label: m.lmu_guide_content_reference_symptoms_midUnder_causes_camber_label(),
            fix: m.lmu_guide_content_reference_symptoms_midUnder_causes_camber_fix(),
          },
          {
            id: "springF",
            label: m.lmu_guide_content_reference_symptoms_midUnder_causes_springF_label(),
            fix: m.lmu_guide_content_reference_symptoms_midUnder_causes_springF_fix(),
          },
          {
            id: "pressure",
            label: m.lmu_guide_content_reference_symptoms_midUnder_causes_pressure_label(),
            fix: m.lmu_guide_content_reference_symptoms_midUnder_causes_pressure_fix(),
          },
        ],
      },
      {
        id: "midOver",
        group: m.lmu_guide_content_reference_symptoms_midUnder_group(),
        name: m.lmu_guide_content_reference_symptoms_midOver_name(),
        description: m.lmu_guide_content_reference_symptoms_midOver_description(),
        quick: m.lmu_guide_content_reference_symptoms_midOver_quick(),
        causes: [
          {
            id: "arbR",
            label: m.lmu_guide_content_reference_symptoms_midOver_causes_arbR_label(),
            fix: m.lmu_guide_content_reference_symptoms_midOver_causes_arbR_fix(),
          },
          {
            id: "camber",
            label: m.lmu_guide_content_reference_symptoms_midOver_causes_camber_label(),
            fix: m.lmu_guide_content_reference_symptoms_midOver_causes_camber_fix(),
          },
          {
            id: "toe",
            label: m.lmu_guide_content_reference_symptoms_midOver_causes_toe_label(),
            fix: m.lmu_guide_content_reference_symptoms_midOver_causes_toe_fix(),
          },
          {
            id: "pressure",
            label: m.lmu_guide_content_reference_symptoms_midOver_causes_pressure_label(),
            fix: m.lmu_guide_content_reference_symptoms_midOver_causes_pressure_fix(),
          },
        ],
      },
      {
        id: "fastUnder",
        group: m.lmu_guide_content_reference_symptoms_fastUnder_group(),
        name: m.lmu_guide_content_reference_symptoms_fastUnder_name(),
        description: m.lmu_guide_content_reference_symptoms_fastUnder_description(),
        quick: m.lmu_guide_content_reference_symptoms_fastUnder_quick(),
        causes: [
          {
            id: "rideHeightF",
            label: m.lmu_guide_content_reference_symptoms_fastUnder_causes_rideHeightF_label(),
            fix: m.lmu_guide_content_reference_symptoms_fastUnder_causes_rideHeightF_fix(),
          },
          {
            id: "frontSplitter",
            label: m.lmu_guide_content_reference_symptoms_fastUnder_causes_frontSplitter_label(),
            fix: m.lmu_guide_content_reference_symptoms_fastUnder_causes_frontSplitter_fix(),
          },
          {
            id: "rearWing",
            label: m.lmu_guide_content_reference_symptoms_fastUnder_causes_rearWing_label(),
            fix: m.lmu_guide_content_reference_symptoms_fastUnder_causes_rearWing_fix(),
          },
        ],
      },
      {
        id: "fastOver",
        group: m.lmu_guide_content_reference_symptoms_fastUnder_group(),
        name: m.lmu_guide_content_reference_symptoms_fastOver_name(),
        description: m.lmu_guide_content_reference_symptoms_fastOver_description(),
        quick: m.lmu_guide_content_reference_symptoms_fastOver_quick(),
        causes: [
          {
            id: "rearWing",
            label: m.lmu_guide_content_reference_symptoms_fastOver_causes_rearWing_label(),
            fix: m.lmu_guide_content_reference_symptoms_fastOver_causes_rearWing_fix(),
          },
          {
            id: "rideHeightR",
            label: m.lmu_guide_content_reference_symptoms_fastOver_causes_rideHeightR_label(),
            fix: m.lmu_guide_content_reference_symptoms_fastOver_causes_rideHeightR_fix(),
          },
          {
            id: "bumpstops",
            label: m.lmu_guide_content_reference_symptoms_fastOver_causes_bumpstops_label(),
            fix: m.lmu_guide_content_reference_symptoms_fastOver_causes_bumpstops_fix(),
          },
          {
            id: "dampers",
            label: m.lmu_guide_content_reference_symptoms_fastOver_causes_dampers_label(),
            fix: m.lmu_guide_content_reference_symptoms_fastOver_causes_dampers_fix(),
          },
        ],
      },
      {
        id: "exitSpin",
        group: m.lmu_guide_content_reference_symptoms_exitSpin_group(),
        name: m.lmu_guide_content_reference_symptoms_exitSpin_name(),
        description: m.lmu_guide_content_reference_symptoms_exitSpin_description(),
        quick: m.lmu_guide_content_reference_symptoms_exitSpin_quick(),
        causes: [
          {
            id: "springR",
            label: m.lmu_guide_content_reference_symptoms_exitSpin_causes_springR_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitSpin_causes_springR_fix(),
          },
          {
            id: "arbR",
            label: m.lmu_guide_content_reference_symptoms_midOver_causes_arbR_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitSpin_causes_arbR_fix(),
          },
          {
            id: "diffPreload",
            label: m.lmu_guide_content_reference_symptoms_exitSpin_causes_diffPreload_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitSpin_causes_diffPreload_fix(),
          },
          {
            id: "toe",
            label: m.lmu_guide_content_reference_symptoms_midOver_causes_toe_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitSpin_causes_toe_fix(),
          },
          {
            id: "electronics",
            label: m.lmu_guide_content_reference_symptoms_exitSpin_causes_electronics_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitSpin_causes_electronics_fix(),
          },
        ],
      },
      {
        id: "exitPush",
        group: m.lmu_guide_content_reference_symptoms_exitSpin_group(),
        name: m.lmu_guide_content_reference_symptoms_exitPush_name(),
        description: m.lmu_guide_content_reference_symptoms_exitPush_description(),
        quick: m.lmu_guide_content_reference_symptoms_exitPush_quick(),
        causes: [
          {
            id: "diffPreload",
            label: m.lmu_guide_content_reference_symptoms_exitPush_causes_diffPreload_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitPush_causes_diffPreload_fix(),
          },
          {
            id: "springR",
            label: m.lmu_guide_content_reference_symptoms_exitPush_causes_springR_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitPush_causes_springR_fix(),
          },
          {
            id: "electronics",
            label: m.lmu_guide_content_reference_symptoms_exitPush_causes_electronics_label(),
            fix: m.lmu_guide_content_reference_symptoms_exitPush_causes_electronics_fix(),
          },
        ],
      },
      {
        id: "frontLock",
        group: m.lmu_guide_content_reference_symptoms_frontLock_group(),
        name: m.lmu_guide_content_reference_symptoms_frontLock_name(),
        description: m.lmu_guide_content_reference_symptoms_frontLock_description(),
        quick: m.lmu_guide_content_reference_symptoms_frontLock_quick(),
        causes: [
          {
            id: "brakePressure",
            label: m.lmu_guide_content_reference_symptoms_frontLock_causes_brakePressure_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontLock_causes_brakePressure_fix(),
          },
          {
            id: "brakeBias",
            label: m.lmu_guide_content_reference_symptoms_entryUnder_causes_brakeBias_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontLock_causes_brakeBias_fix(),
          },
          {
            id: "regen",
            label: m.lmu_guide_content_reference_symptoms_frontLock_causes_regen_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontLock_causes_regen_fix(),
          },
          {
            id: "electronics",
            label: m.lmu_guide_content_reference_symptoms_frontLock_causes_electronics_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontLock_causes_electronics_fix(),
          },
          {
            id: "brakeDucts",
            label: m.lmu_guide_content_reference_symptoms_frontLock_causes_brakeDucts_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontLock_causes_brakeDucts_fix(),
          },
          {
            id: "camber",
            label: m.lmu_guide_content_reference_symptoms_frontLock_causes_camber_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontLock_causes_camber_fix(),
          },
        ],
      },
      {
        id: "kerbLaunch",
        group: m.lmu_guide_content_reference_symptoms_kerbLaunch_group(),
        name: m.lmu_guide_content_reference_symptoms_kerbLaunch_name(),
        description: m.lmu_guide_content_reference_symptoms_kerbLaunch_description(),
        quick: m.lmu_guide_content_reference_symptoms_kerbLaunch_quick(),
        causes: [
          {
            id: "dampers",
            label: m.lmu_guide_content_reference_symptoms_kerbLaunch_causes_dampers_label(),
            fix: m.lmu_guide_content_reference_symptoms_kerbLaunch_causes_dampers_fix(),
          },
          {
            id: "bumpstops",
            label: m.lmu_guide_content_reference_symptoms_kerbLaunch_causes_bumpstops_label(),
            fix: m.lmu_guide_content_reference_symptoms_kerbLaunch_causes_bumpstops_fix(),
          },
          {
            id: "rideHeightF",
            label: m.lmu_guide_content_reference_symptoms_kerbLaunch_causes_rideHeightF_label(),
            fix: m.lmu_guide_content_reference_symptoms_kerbLaunch_causes_rideHeightF_fix(),
          },
        ],
      },
      {
        id: "bumpUnder",
        group: m.lmu_guide_content_reference_symptoms_kerbLaunch_group(),
        name: m.lmu_guide_content_reference_symptoms_bumpUnder_name(),
        description: m.lmu_guide_content_reference_symptoms_bumpUnder_description(),
        quick: m.lmu_guide_content_reference_symptoms_bumpUnder_quick(),
        causes: [
          {
            id: "bumpstops",
            label: m.lmu_guide_content_reference_symptoms_bumpUnder_causes_bumpstops_label(),
            fix: m.lmu_guide_content_reference_symptoms_bumpUnder_causes_bumpstops_fix(),
          },
          {
            id: "rideHeightF",
            label: m.lmu_guide_content_reference_symptoms_bumpUnder_causes_rideHeightF_label(),
            fix: m.lmu_guide_content_reference_symptoms_bumpUnder_causes_rideHeightF_fix(),
          },
          {
            id: "springF",
            label: m.lmu_guide_content_reference_symptoms_bumpUnder_causes_springF_label(),
            fix: m.lmu_guide_content_reference_symptoms_bumpUnder_causes_springF_fix(),
          },
        ],
      },
      {
        id: "hotPressures",
        group: m.lmu_guide_content_reference_symptoms_hotPressures_group(),
        name: m.lmu_guide_content_reference_symptoms_hotPressures_name(),
        description: m.lmu_guide_content_reference_symptoms_hotPressures_description(),
        quick: m.lmu_guide_content_reference_symptoms_hotPressures_quick(),
        causes: [
          {
            id: "pressure",
            label: m.lmu_guide_content_reference_symptoms_hotPressures_causes_pressure_label(),
            fix: m.lmu_guide_content_reference_symptoms_hotPressures_causes_pressure_fix(),
          },
          {
            id: "brakeDucts",
            label: m.lmu_guide_content_reference_symptoms_hotPressures_causes_brakeDucts_label(),
            fix: m.lmu_guide_content_reference_symptoms_hotPressures_causes_brakeDucts_fix(),
          },
          {
            id: "toe",
            label: m.lmu_guide_content_reference_symptoms_hotPressures_causes_toe_label(),
            fix: m.lmu_guide_content_reference_symptoms_hotPressures_causes_toe_fix(),
          },
          {
            id: "electronics",
            label: m.lmu_guide_content_reference_symptoms_hotPressures_causes_electronics_label(),
            fix: m.lmu_guide_content_reference_symptoms_hotPressures_causes_electronics_fix(),
          },
        ],
      },
      {
        id: "coldTyres",
        group: m.lmu_guide_content_reference_symptoms_hotPressures_group(),
        name: m.lmu_guide_content_reference_symptoms_coldTyres_name(),
        description: m.lmu_guide_content_reference_symptoms_coldTyres_description(),
        quick: m.lmu_guide_content_reference_symptoms_coldTyres_quick(),
        causes: [
          {
            id: "brakeDucts",
            label: m.lmu_guide_content_reference_symptoms_coldTyres_causes_brakeDucts_label(),
            fix: m.lmu_guide_content_reference_symptoms_coldTyres_causes_brakeDucts_fix(),
          },
          {
            id: "pressure",
            label: m.lmu_guide_content_reference_symptoms_coldTyres_causes_pressure_label(),
            fix: m.lmu_guide_content_reference_symptoms_coldTyres_causes_pressure_fix(),
          },
          {
            id: "camber",
            label: m.lmu_guide_content_reference_symptoms_coldTyres_causes_camber_label(),
            fix: m.lmu_guide_content_reference_symptoms_coldTyres_causes_camber_fix(),
          },
        ],
      },
      {
        id: "hybridBrake",
        group: m.lmu_guide_content_reference_symptoms_frontLock_group(),
        name: m.lmu_guide_content_reference_symptoms_hybridBrake_name(),
        description: m.lmu_guide_content_reference_symptoms_hybridBrake_description(),
        quick: m.lmu_guide_content_reference_symptoms_hybridBrake_quick(),
        causes: [
          {
            id: "regen",
            label: m.lmu_guide_content_reference_symptoms_hybridBrake_causes_regen_label(),
            fix: m.lmu_guide_content_reference_symptoms_hybridBrake_causes_regen_fix(),
          },
          {
            id: "brakeBias",
            label: m.lmu_guide_content_reference_symptoms_hybridBrake_causes_brakeBias_label(),
            fix: m.lmu_guide_content_reference_symptoms_hybridBrake_causes_brakeBias_fix(),
          },
          {
            id: "brakeMigration",
            label: m.lmu_guide_content_reference_symptoms_hybridBrake_causes_brakeMigration_label(),
            fix: m.lmu_guide_content_reference_symptoms_hybridBrake_causes_brakeMigration_fix(),
          },
        ],
      },
      {
        id: "energyShort",
        group: m.lmu_guide_content_reference_symptoms_hotPressures_group(),
        name: m.lmu_guide_content_reference_symptoms_energyShort_name(),
        description: m.lmu_guide_content_reference_symptoms_energyShort_description(),
        quick: m.lmu_guide_content_reference_symptoms_energyShort_quick(),
        causes: [
          {
            id: "virtualEnergy",
            label: m.lmu_guide_content_reference_symptoms_energyShort_causes_virtualEnergy_label(),
            fix: m.lmu_guide_content_reference_symptoms_energyShort_causes_virtualEnergy_fix(),
          },
          {
            id: "fuelRatio",
            label: m.lmu_guide_content_reference_symptoms_energyShort_causes_fuelRatio_label(),
            fix: m.lmu_guide_content_reference_symptoms_energyShort_causes_fuelRatio_fix(),
          },
          {
            id: "motorMap",
            label: m.lmu_guide_content_reference_symptoms_energyShort_causes_motorMap_label(),
            fix: m.lmu_guide_content_reference_symptoms_energyShort_causes_motorMap_fix(),
          },
          {
            id: "regen",
            label: m.lmu_guide_content_reference_symptoms_energyShort_causes_regen_label(),
            fix: m.lmu_guide_content_reference_symptoms_energyShort_causes_regen_fix(),
          },
        ],
      },
      {
        id: "frontDiffEntry",
        group: m.lmu_guide_content_reference_symptoms_entryUnder_group(),
        name: m.lmu_guide_content_reference_symptoms_frontDiffEntry_name(),
        description: m.lmu_guide_content_reference_symptoms_frontDiffEntry_description(),
        quick: m.lmu_guide_content_reference_symptoms_frontDiffEntry_quick(),
        causes: [
          {
            id: "frontDiff",
            label: m.lmu_guide_content_reference_symptoms_frontDiffEntry_causes_frontDiff_free_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontDiffEntry_causes_frontDiff_free_fix(),
          },
          {
            id: "frontDiff",
            label: m.lmu_guide_content_reference_symptoms_frontDiffEntry_causes_frontDiff_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontDiffEntry_causes_frontDiff_fix(),
          },
          {
            id: "motorMap",
            label: m.lmu_guide_content_reference_symptoms_frontDiffEntry_causes_motorMap_label(),
            fix: m.lmu_guide_content_reference_symptoms_frontDiffEntry_causes_motorMap_fix(),
          },
        ],
      },
    ],
    officialTopics: [
      {
        id: "motor-map",
        parameterId: "motorMap",
        title: m.lmu_guide_content_reference_officialTopics_motor_map_title(),
        summary: m.lmu_guide_content_reference_parameters_motorMap_does(),
        facts: [
          m.lmu_guide_content_reference_officialTopics_motor_map_facts_0(),
          m.lmu_guide_content_reference_officialTopics_motor_map_facts_1(),
          m.lmu_guide_content_reference_officialTopics_motor_map_facts_2(),
        ],
        sources: [
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_0_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152322265231-Hypercar-Category-LMH-LMDh",
            reviewedAt: "2026-10-04",
          },
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_1_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152376674191-What-is-Virtual-Energy-NRG",
            reviewedAt: "2026-10-04",
          },
        ],
      },
      {
        id: "regeneration",
        parameterId: "regen",
        title: m.lmu_guide_content_reference_officialTopics_regeneration_title(),
        summary: m.lmu_guide_content_reference_officialTopics_regeneration_summary(),
        facts: [
          m.lmu_guide_content_reference_officialTopics_regeneration_facts_0(),
          m.lmu_guide_content_reference_officialTopics_regeneration_facts_1(),
          m.lmu_guide_content_reference_officialTopics_regeneration_facts_2(),
        ],
        sources: [
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_0_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152322265231-Hypercar-Category-LMH-LMDh",
            reviewedAt: "2026-10-04",
          },
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_1_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152376674191-What-is-Virtual-Energy-NRG",
            reviewedAt: "2026-10-04",
          },
        ],
      },
      {
        id: "virtual-energy",
        parameterId: "virtualEnergy",
        title: m.lmu_guide_content_reference_officialTopics_virtual_energy_title(),
        summary: m.lmu_guide_content_reference_officialTopics_virtual_energy_summary(),
        facts: [
          m.lmu_guide_content_reference_officialTopics_virtual_energy_facts_0(),
          m.lmu_guide_content_reference_officialTopics_virtual_energy_facts_1(),
          m.lmu_guide_content_reference_officialTopics_virtual_energy_facts_2(),
          m.lmu_guide_content_reference_officialTopics_virtual_energy_facts_3(),
        ],
        sources: [
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_1_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152376674191-What-is-Virtual-Energy-NRG",
            reviewedAt: "2026-10-04",
          },
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_0_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152322265231-Hypercar-Category-LMH-LMDh",
            reviewedAt: "2026-10-04",
          },
        ],
      },
      {
        id: "fuel-ratio",
        parameterId: "fuelRatio",
        title: m.lmu_guide_content_reference_officialTopics_fuel_ratio_title(),
        summary: m.lmu_guide_content_reference_officialTopics_fuel_ratio_summary(),
        facts: [
          m.lmu_guide_content_reference_officialTopics_fuel_ratio_facts_0(),
          m.lmu_guide_content_reference_officialTopics_fuel_ratio_facts_1(),
          m.lmu_guide_content_reference_officialTopics_fuel_ratio_facts_2(),
        ],
        sources: [
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_0_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152322265231-Hypercar-Category-LMH-LMDh",
            reviewedAt: "2026-10-04",
          },
          {
            title: m.lmu_guide_content_reference_officialTopics_motor_map_sources_1_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13152376674191-What-is-Virtual-Energy-NRG",
            reviewedAt: "2026-10-04",
          },
        ],
      },
      {
        id: "abs-maps",
        parameterId: "electronics",
        title: m.lmu_guide_content_reference_officialTopics_abs_maps_title(),
        summary: m.lmu_guide_content_reference_officialTopics_abs_maps_summary(),
        facts: [
          m.lmu_guide_content_reference_officialTopics_abs_maps_facts_0(),
          m.lmu_guide_content_reference_officialTopics_abs_maps_facts_1(),
          m.lmu_guide_content_reference_officialTopics_abs_maps_facts_2(),
        ],
        sources: [
          {
            title: m.lmu_guide_content_reference_officialTopics_abs_maps_sources_0_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13211078435983-ABS-Anti-Lock-Braking-System-for-LMGT3-Cars",
            reviewedAt: "2026-10-04",
          },
        ],
      },
      {
        id: "traction-control",
        parameterId: "electronics",
        title: m.lmu_guide_content_reference_officialTopics_traction_control_title(),
        summary: m.lmu_guide_content_reference_officialTopics_traction_control_summary(),
        facts: [
          m.lmu_guide_content_reference_officialTopics_traction_control_facts_0(),
          m.lmu_guide_content_reference_officialTopics_traction_control_facts_1(),
          m.lmu_guide_content_reference_officialTopics_traction_control_facts_2(),
        ],
        sources: [
          {
            title: m.lmu_guide_content_reference_officialTopics_traction_control_sources_0_title(),
            url: "https://guide.lemansultimate.com/hc/en-gb/articles/13182869047311-How-do-I-configure-my-traction-control-in-Le-Mans-Ultimate",
            reviewedAt: "2026-10-04",
          },
        ],
      },
    ],
  };
}
