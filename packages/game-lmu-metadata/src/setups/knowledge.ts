/* Adapted from Setup Ripple LMU by JojoJing (c) 2026, pinned commit 6239277da04a1f09027591aaa00fd047780b6efa.
 * https://github.com/jojojing-dev/setup-ripple/blob/6239277da04a1f09027591aaa00fd047780b6efa/setup-ripple-lmu.html
 * MIT License
 * Copyright (c) 2026 JojoJing
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { SvmDocument } from "./svm";
import { getSvmCapabilities, getSvmFieldAccess } from "./capabilities";
import { LMU_OFFICIAL_MOTOR_MAP } from "./official-knowledge";

export interface AdviceAvailability { readonly available: boolean; readonly reason: string | null }
export interface AdviceItem<T> { readonly item: T; readonly availability: AdviceAvailability }
export interface Compensation { readonly id: string; readonly text: string }
export interface ParameterAdvice { readonly id:string; readonly group:string; readonly name:string; readonly upLabel:string; readonly downLabel:string; readonly does:string; readonly up:{readonly effects:readonly string[];readonly compensations:readonly Compensation[]}; readonly down:{readonly effects:readonly string[];readonly compensations:readonly Compensation[]}; readonly linked:readonly {readonly id:string;readonly reason:string}[]; readonly note:string }
export interface SymptomCause { readonly id:string; readonly label:string; readonly fix:string }
export interface SymptomAdvice { readonly id:string; readonly group:string; readonly name:string; readonly description:string; readonly quick:string; readonly causes:readonly SymptomCause[] }
export interface PresetTarget { readonly section:string; readonly key:string; readonly label:string; readonly delta:number|null }
export interface PresetAdvice { readonly id:string; readonly group:string; readonly name:string; readonly description:string; readonly noAbs:boolean; readonly targets:readonly PresetTarget[] }
export type AdviceCause = SymptomCause & { readonly availability: AdviceAvailability };
export type AdvicePresetTarget = PresetTarget & { readonly availability: AdviceAvailability };
export const LMU_PARAMETERS: readonly ParameterAdvice[] = [
  {
    "id": "pressure",
    "group": "Tyres",
    "name": "Tyre pressures",
    "upLabel": "Raise",
    "downLabel": "Lower",
    "does": "Set contact-patch shape and grip. Use car-, compound- and track-specific game values, tyre temperatures and telemetry; pressures rise as tyres heat during a stint.",
    "up": {
      "effects": [
        "Above a useful range, grip may decline and slides can become less progressive",
        "Centre of the tread overheats first; slides get snappier, less progressive",
        "Slightly sharper initial steering response and lower rolling resistance",
        "Balance effects depend on axle and vehicle"
      ],
      "compensations": [
        {
          "id": "brakeDucts",
          "text": "Open the brake ducts a step. Brake heat soaks into the rim and is often why pressures creep high"
        },
        {
          "id": "camber",
          "text": "Check camber: too much inner-edge temperature drags the whole pressure up"
        }
      ]
    },
    "down": {
      "effects": [
        "Too little pressure can make response vague and increase shoulder loading",
        "Tyres may take longer to reach useful temperature",
        "Axle-specific effects vary by vehicle"
      ],
      "compensations": [
        {
          "id": "brakeDucts",
          "text": "Close the ducts a step to push more heat into the rims and lift pressures"
        }
      ]
    },
    "linked": [
      {
        "id": "brakeDucts",
        "reason": "Duct openings are your main in-race pressure control. Heat from the discs feeds straight into the rims"
      },
      {
        "id": "camber",
        "reason": "Camber decides how temperature spreads across the tread, which feeds back into pressure"
      },
      {
        "id": "rideHeightF",
        "reason": "Pressure changes alter tyre radius slightly, nudging ride height and rake"
      }
    ],
    "note": "Track temperature and fuel burn affect tyre behaviour over a stint. Reassess using current telemetry."
  },
  {
    "id": "camber",
    "group": "Tyres",
    "name": "Camber",
    "upLabel": "More negative",
    "downLabel": "Less negative",
    "does": "Tilts the top of the tyre inwards so the tread sits flat when the car rolls in a corner. You are trading mid-corner grip against straight-line braking and traction.",
    "up": {
      "effects": [
        "More mid-corner grip at that axle as the tread loads evenly under roll",
        "Inner-edge temperature climbs; compare inner, middle and outer telemetry",
        "Less braking and traction grip in a straight line (smaller upright contact patch)",
        "Per axle: more front camber = sharper, slightly looser mid-corner; more rear = more planted, tighter"
      ],
      "compensations": [
        {
          "id": "pressure",
          "text": "Re-check hot pressures. The inner edge will be doing more work"
        },
        {
          "id": "toe",
          "text": "A touch less front toe-out offsets the extra scrub heat"
        }
      ]
    },
    "down": {
      "effects": [
        "Better braking and corner-exit traction, weaker mid-corner",
        "Outer shoulder takes more punishment in long corners",
        "More even wear on tracks with few fast corners"
      ],
      "compensations": [
        {
          "id": "arbF",
          "text": "If mid-corner grip drops too far, soften the ARB at that end instead of adding camber back"
        }
      ]
    },
    "linked": [
      {
        "id": "pressure",
        "reason": "Camber redistributes heat across the tread, which moves hot pressures"
      },
      {
        "id": "caster",
        "reason": "Caster adds dynamic camber when steered. More caster lets you run less static camber"
      }
    ],
    "note": "Use inner, middle and outer tyre temperatures on the car and track in use; avoid a universal camber target."
  },
  {
    "id": "toe",
    "group": "Tyres",
    "name": "Toe",
    "upLabel": "More toe",
    "downLabel": "Less toe",
    "does": "Angles the wheels relative to straight ahead. Convention: front toe-out for response, rear toe-in for stability. \"More toe\" here means more toe-out at the front or more toe-in at the rear.",
    "up": {
      "effects": [
        "Front toe-out: sharper, more eager turn-in. The inside wheel is already pointing into the corner",
        "Rear toe-in: calmer, more planted corner exits and better stability over kerbs",
        "Both add scrub. More tyre temperature, more wear, a touch more drag",
        "Too much front toe-out makes the car nervous and darty in a straight line"
      ],
      "compensations": [
        {
          "id": "pressure",
          "text": "Watch hot pressures rise from the extra scrub"
        },
        {
          "id": "electronics",
          "text": "With added rear toe-in you can often run one click less TC"
        }
      ]
    },
    "down": {
      "effects": [
        "Straighter-running, lower drag, cooler tyres. Good for long straights and tyre life",
        "Lazier turn-in at the front; livelier (less damped) rear on exit",
        "Front toe near zero suits flowing tracks; tight tracks miss the response"
      ],
      "compensations": [
        {
          "id": "caster",
          "text": "Add caster to recover some turn-in feel without the scrub penalty"
        },
        {
          "id": "arbF",
          "text": "A softer front ARB can also wake up turn-in"
        }
      ]
    },
    "linked": [
      {
        "id": "pressure",
        "reason": "Toe scrub is a steady heat source. It shifts where your pressures settle"
      },
      {
        "id": "caster",
        "reason": "Caster and front toe both shape turn-in; tune them together"
      }
    ],
    "note": "Balance shift shown is for the usual case (front response / rear stability traded together). Tune one axle at a time."
  },
  {
    "id": "caster",
    "group": "Tyres",
    "name": "Caster",
    "upLabel": "More",
    "downLabel": "Less",
    "does": "Tilts the steering axis backwards. More caster gains camber as you steer. Grip arrives exactly when you wind on lock, and strengthens self-centring.",
    "up": {
      "effects": [
        "More dynamic camber mid-corner: front grip improves the more lock you carry",
        "Heavier, more communicative steering with stronger self-centring",
        "Slightly more stable under braking",
        "Usually low downside. Many setups run plenty of caster for the front grip"
      ],
      "compensations": [
        {
          "id": "camber",
          "text": "You may be able to take out a little static camber and gain braking grip for free"
        }
      ]
    },
    "down": {
      "effects": [
        "Lighter steering, weaker feedback",
        "Less camber gain. The front washes out earlier in long corners"
      ],
      "compensations": [
        {
          "id": "camber",
          "text": "Add static camber back to recover mid-corner front grip"
        }
      ]
    },
    "linked": [
      {
        "id": "camber",
        "reason": "Caster is camber-on-demand: the two budgets add together when steered"
      }
    ],
    "note": "Caster is close to a free upgrade for front grip on cars that expose it. Lower it mainly if steering weight bothers you. Note many LMU cars list caster as non-adjustable."
  },
  {
    "id": "rearWing",
    "group": "Aero",
    "name": "Rear wing",
    "upLabel": "More wing",
    "downLabel": "Less wing",
    "does": "The big lever for rear downforce. Every step changes three things at once: rear grip at speed, drag, and the front-to-rear aero balance. Its effects grow with speed. It does almost nothing in a hairpin.",
    "up": {
      "effects": [
        "Rear planted in fast corners and under braking from high speed",
        "More drag. Top speed drops, fuel use rises slightly",
        "Aero balance moves rearwards: understeer builds the faster the corner",
        "Car becomes less pitch-sensitive. More forgiving over crests and kerbs at speed"
      ],
      "compensations": [
        {
          "id": "rideHeightF",
          "text": "Lower the front (or raise the rear). More rake pulls aero balance forward again"
        },
        {
          "id": "frontSplitter",
          "text": "Add a splitter step if the car has one, to match the front to the new rear"
        },
        {
          "id": "brakeBias",
          "text": "Move bias rearwards ~0.5%. The rear can now take more braking load"
        },
        {
          "id": "arbF",
          "text": "Soften the front ARB a click to claw back grip in the slow corners the wing can't help"
        }
      ]
    },
    "down": {
      "effects": [
        "Top speed up. Strong on long straights and for defending",
        "Rear gets light in fast corners and under braking from speed",
        "Oversteer grows with speed; the car rewards smooth hands",
        "More pitch-sensitive: kerbs and bumps at speed unsettle it more"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "Move bias forward to protect the now-lighter rear under braking"
        },
        {
          "id": "rideHeightR",
          "text": "Drop the rear a touch (less rake) to push aero balance back"
        },
        {
          "id": "arbR",
          "text": "Soften the rear ARB so mechanical grip covers some of what the aero gave up"
        }
      ]
    },
    "linked": [
      {
        "id": "rideHeightF",
        "reason": "Rake and wing together set the aero balance. Change one, re-check the other"
      },
      {
        "id": "brakeBias",
        "reason": "Rear downforce decides how much braking the rear axle can take at speed"
      },
      {
        "id": "springR",
        "reason": "More wing means more load crushing the rear at speed. The springs must hold the platform"
      },
      {
        "id": "frontSplitter",
        "reason": "Front and rear aero are a matched pair; moving one strands the other"
      }
    ],
    "note": "Rule of thumb: if the balance problem appears only in fast corners, it's aero. If it's everywhere, look at mechanical grip first."
  },
  {
    "id": "frontSplitter",
    "group": "Aero",
    "name": "Front splitter",
    "upLabel": "More splitter",
    "downLabel": "Less splitter",
    "does": "Adds front downforce on cars that expose a front-aero adjustment (front wing position, splitter, or front diffuser, depending on the car). The front-end counterpart to the rear wing, and like the wing, it only works at speed.",
    "up": {
      "effects": [
        "Front bites harder in fast corners. Turn-in at speed sharpens",
        "Aero balance moves forward: the rear becomes comparatively lighter",
        "Small drag increase",
        "Works harder the closer the front runs to the ground"
      ],
      "compensations": [
        {
          "id": "rearWing",
          "text": "Add wing to keep the rear matched"
        },
        {
          "id": "rideHeightF",
          "text": "Raise the front slightly if high-speed oversteer appears"
        }
      ]
    },
    "down": {
      "effects": [
        "High-speed understeer; the rear feels relatively more secure",
        "A touch less drag"
      ],
      "compensations": [
        {
          "id": "rearWing",
          "text": "Trim a step of wing to re-centre the aero balance"
        }
      ]
    },
    "linked": [
      {
        "id": "rearWing",
        "reason": "Splitter and wing set the two ends of the aero see-saw"
      },
      {
        "id": "rideHeightF",
        "reason": "Splitter performance is very sensitive to front ride height"
      }
    ],
    "note": "If your car has no splitter setting, rake (ride heights) is your front-downforce tool instead."
  },
  {
    "id": "rideHeightF",
    "group": "Aero",
    "name": "Front ride height",
    "upLabel": "Raise",
    "downLabel": "Lower",
    "does": "With the rear height, this sets rake. The nose-down angle of the floor. More rake (lower front) means more front downforce. Lower also drops the centre of gravity. The catch: run too low and the car sits on its bumpstops.",
    "up": {
      "effects": [
        "Less rake. Aero balance shifts rearwards, high-speed understeer",
        "More suspension travel: friendlier over kerbs and bumps",
        "Slightly higher centre of gravity"
      ],
      "compensations": [
        {
          "id": "rearWing",
          "text": "Trim a step of wing so the rear doesn't over-dominate the new balance"
        },
        {
          "id": "rideHeightR",
          "text": "Raise the rear by the same amount if you only wanted clearance, not a rake change"
        }
      ]
    },
    "down": {
      "effects": [
        "More rake. Front downforce up, sharper at speed",
        "Lower centre of gravity: a little less weight transfer everywhere",
        "Risk: bottoming onto the bumpstops mid-corner causes sudden, ugly understeer over bumps and kerbs"
      ],
      "compensations": [
        {
          "id": "bumpstops",
          "text": "Stiffen or shorten bumpstop range so the platform stays controlled when it touches down"
        },
        {
          "id": "springF",
          "text": "Stiffer front springs help hold the car off the stops"
        },
        {
          "id": "rearWing",
          "text": "If it's now loose at speed, a step of wing rebalances it"
        }
      ]
    },
    "linked": [
      {
        "id": "bumpstops",
        "reason": "The lower you run, the more the bumpstops become part of the active suspension"
      },
      {
        "id": "frontSplitter",
        "reason": "Splitter downforce rises sharply as the front nears the ground"
      },
      {
        "id": "springF",
        "reason": "Springs and ride height together decide whether the floor stays where you put it"
      },
      {
        "id": "rearWing",
        "reason": "Rake and wing are the two halves of aero balance"
      }
    ],
    "note": "Low-and-stiff setups lean on this: maximum rake with the bumpstops doing real work to hold the aero platform."
  },
  {
    "id": "rideHeightR",
    "group": "Aero",
    "name": "Rear ride height",
    "upLabel": "Raise",
    "downLabel": "Lower",
    "does": "The other half of rake. Raising the rear tips the floor nose-down (more rake, more front aero) but lifts the centre of gravity at the driven axle.",
    "up": {
      "effects": [
        "More rake. Aero balance forward, livelier at speed",
        "Higher rear CoG: a bit more weight transfer, slightly more squat and dive",
        "Diffuser/floor generally works the rake harder (car-dependent)"
      ],
      "compensations": [
        {
          "id": "rearWing",
          "text": "A step of wing covers the rear if high-speed confidence drops"
        },
        {
          "id": "springR",
          "text": "Check rear springs. More transfer may want a touch more support"
        }
      ]
    },
    "down": {
      "effects": [
        "Less rake, high-speed understeer tendency",
        "Lower CoG at the rear: traction off slow corners often improves",
        "Less travel before the rear bumpstops"
      ],
      "compensations": [
        {
          "id": "rideHeightF",
          "text": "Lower the front too if you want the rake back with a lower car overall"
        }
      ]
    },
    "linked": [
      {
        "id": "rideHeightF",
        "reason": "Rake is the difference between the two heights. They only mean something together"
      },
      {
        "id": "rearWing",
        "reason": "Rake and wing trade against each other for the same aero balance"
      },
      {
        "id": "springR",
        "reason": "Height changes shift how soon the rear reaches its bumpstops"
      }
    ],
    "note": "Tune rake in small steps. Evaluate rake on the car and track in use."
  },
  {
    "id": "springF",
    "group": "Suspension & dampers",
    "name": "Front springs",
    "upLabel": "Stiffer",
    "downLabel": "Softer",
    "does": "Wheel rate at the front. Stiffness trades slow-corner mechanical grip against response and aero platform stability.",
    "up": {
      "effects": [
        "Sharper, more immediate turn-in response",
        "Less mechanical front grip. Understeer in slow corners",
        "Steadier front platform: splitter and rake work more consistently at speed (can make it *looser* in fast corners)",
        "Harsher over kerbs and bumps"
      ],
      "compensations": [
        {
          "id": "arbF",
          "text": "Soften the front ARB to win back slow-corner grip while keeping the response"
        },
        {
          "id": "dampers",
          "text": "Re-match damper rates to the new spring. Stiffer springs want more damping"
        },
        {
          "id": "rideHeightF",
          "text": "You can often run a little lower now the spring holds the platform"
        }
      ]
    },
    "down": {
      "effects": [
        "More slow-corner front grip as the tyre stays loaded over bumps",
        "Lazier response; more dive under braking",
        "Front aero platform moves around more. Less consistent at speed"
      ],
      "compensations": [
        {
          "id": "dampers",
          "text": "Soften front damping to match, or the spring can't do its job"
        },
        {
          "id": "rideHeightF",
          "text": "May need a touch more ride height to avoid the bumpstops"
        }
      ]
    },
    "linked": [
      {
        "id": "dampers",
        "reason": "Dampers are tuned to the spring. Change one without the other and the wheel loses contact"
      },
      {
        "id": "bumpstops",
        "reason": "Softer springs reach the stops sooner; stiffer springs may never use them"
      },
      {
        "id": "rideHeightF",
        "reason": "Spring rate decides how far the car settles and how low you can safely run"
      }
    ],
    "note": "Mechanical grip rules according to the corner and platform. Decide which corners matter at this track before touching springs."
  },
  {
    "id": "springR",
    "group": "Suspension & dampers",
    "name": "Rear springs",
    "upLabel": "Stiffer",
    "downLabel": "Softer",
    "does": "Wheel rate at the rear, the traction axle. The classic trade: softer rear hooks up out of slow corners, stiffer rear holds the aero platform at speed.",
    "up": {
      "effects": [
        "Less traction out of slow corners. Power oversteer appears earlier",
        "Steadier rear platform: more consistent downforce in fast corners",
        "Sharper response to throttle balance changes"
      ],
      "compensations": [
        {
          "id": "arbR",
          "text": "Soften the rear ARB to recover some slow-corner traction"
        },
        {
          "id": "electronics",
          "text": "A click more TC papers over exit wheelspin while you test"
        },
        {
          "id": "dampers",
          "text": "Re-match rear damping"
        }
      ]
    },
    "down": {
      "effects": [
        "Better drive off slow corners. The rear squats and grips",
        "More squat means more dynamic rake change: aero balance moves around on throttle",
        "Slightly tighter feel overall"
      ],
      "compensations": [
        {
          "id": "dampers",
          "text": "Soften rear damping to suit"
        },
        {
          "id": "rideHeightR",
          "text": "Check the rear isn't now sitting on its bumpstops under load"
        }
      ]
    },
    "linked": [
      {
        "id": "diffPreload",
        "reason": "Spring rate and diff locking both shape how the rear puts power down"
      },
      {
        "id": "dampers",
        "reason": "Springs and dampers are one system"
      },
      {
        "id": "rideHeightR",
        "reason": "Softer rear = more squat = the static height number means something different"
      }
    ],
    "note": ""
  },
  {
    "id": "arbF",
    "group": "Suspension & dampers",
    "name": "Front anti-roll bar",
    "upLabel": "Stiffer",
    "downLabel": "Softer",
    "does": "Resists body roll by tying the front wheels together. The cleanest mid-corner balance tool there is. It changes roll stiffness distribution without touching ride or aero.",
    "up": {
      "effects": [
        "Crisper, flatter turn-in",
        "More load forced through the outside front, mid-corner understeer",
        "Inside front stays more planted under braking"
      ],
      "compensations": [
        {
          "id": "arbR",
          "text": "Stiffen the rear bar too if you wanted response, not a balance change"
        },
        {
          "id": "camber",
          "text": "The loaded outside front may want a touch more camber"
        }
      ]
    },
    "down": {
      "effects": [
        "More mid-corner front grip. The car rotates better",
        "Slower, softer initial response; more body roll",
        "Can feel lazy on quick direction changes (chicanes)"
      ],
      "compensations": [
        {
          "id": "dampers",
          "text": "Slightly firmer front slow bump keeps transitions tidy despite the softer bar"
        }
      ]
    },
    "linked": [
      {
        "id": "arbR",
        "reason": "Balance lives in the front/rear bar *ratio*. One bar alone is half the story"
      },
      {
        "id": "springF",
        "reason": "Bars and springs both add roll stiffness; they overlap"
      }
    ],
    "note": "ARBs are the first thing to reach for when the balance problem is mid-corner, at all speeds."
  },
  {
    "id": "arbR",
    "group": "Suspension & dampers",
    "name": "Rear anti-roll bar",
    "upLabel": "Stiffer",
    "downLabel": "Softer",
    "does": "The rear half of the roll-stiffness ratio. Strongly shapes on-throttle behaviour from mid-corner to exit.",
    "up": {
      "effects": [
        "Car rotates more. Oversteer, especially on throttle from mid-corner",
        "Flatter, more responsive rear in direction changes",
        "Inside rear unloads more: worse traction out of slow corners"
      ],
      "compensations": [
        {
          "id": "diffPreload",
          "text": "A little more preload can steady the rear on throttle pickup"
        },
        {
          "id": "electronics",
          "text": "One more click of TC while you learn the new balance"
        }
      ]
    },
    "down": {
      "effects": [
        "More traction and a calmer rear on exit",
        "More roll; slightly lazier in chicanes",
        "Mild understeer tendency mid-corner"
      ],
      "compensations": [
        {
          "id": "arbF",
          "text": "Soften the front bar too if you only wanted traction, not push"
        }
      ]
    },
    "linked": [
      {
        "id": "arbF",
        "reason": "It's the ratio between bars that sets balance"
      },
      {
        "id": "diffPreload",
        "reason": "Both control how the rear behaves under power"
      }
    ],
    "note": ""
  },
  {
    "id": "dampers",
    "group": "Suspension & dampers",
    "name": "Dampers (bump / rebound)",
    "upLabel": "Stiffer",
    "downLabel": "Softer",
    "does": "Dampers don't change how much weight transfers, only how fast. Slow bump/rebound shape braking, turn-in and throttle transitions; fast bump/rebound handle kerbs and bumps. They are your transient balance tool.",
    "up": {
      "effects": [
        "Weight transfer slows down: calmer, more deliberate transitions",
        "Stiffer front bump = less dive, lazier turn-in (entry understeer)",
        "Stiffer rear rebound = rear held down on throttle, steadier exits",
        "Stiffer fast damping = harsh over kerbs; the wheel can skip and lose contact"
      ],
      "compensations": [
        {
          "id": "springF",
          "text": "Damping should track spring rate. If you're maxing dampers, the spring is wrong"
        },
        {
          "id": "bumpstops",
          "text": "On kerb-heavy tracks, let fast damping stay soft and use bumpstops for the platform"
        }
      ]
    },
    "down": {
      "effects": [
        "Faster weight transfer: livelier turn-in, more dive and squat",
        "Better kerb absorption and bumpy-track compliance",
        "Too soft and the car floats. Balance becomes vague and delayed"
      ],
      "compensations": [
        {
          "id": "arbF",
          "text": "If the car got too eager on entry, a stiffer front bar steadies it without slowing the dampers again"
        }
      ]
    },
    "linked": [
      {
        "id": "springF",
        "reason": "Each spring rate has a damping range that suits it"
      },
      {
        "id": "bumpstops",
        "reason": "Fast damping and bumpstops share the job of kerbs and bottoming"
      }
    ],
    "note": "Diagnose dampers by *when* the problem happens: entry/exit transitions = slow damping; kerbs and bumps = fast damping; steady mid-corner = not the dampers."
  },
  {
    "id": "bumpstops",
    "group": "Suspension & dampers",
    "name": "Bumpstops (rate / range)",
    "upLabel": "Stiffer / less range",
    "downLabel": "Softer / more range",
    "does": "Secondary springs that catch the suspension at the end of its travel. In a low-and-stiff setup they're not just a safety net. They become an aero-platform tool the car deliberately rides on.",
    "up": {
      "effects": [
        "Car rides the stops sooner/harder: very consistent aero platform at speed",
        "Sudden balance change the instant one end hits. Can feel like a wall of understeer (front) or a snap (rear)",
        "Harsh over kerbs"
      ],
      "compensations": [
        {
          "id": "rideHeightF",
          "text": "Tune ride height so the stops engage where you want them to, not by accident"
        },
        {
          "id": "springF",
          "text": "Main spring and stop share the load. Set them as a pair"
        }
      ]
    },
    "down": {
      "effects": [
        "More usable travel, friendlier kerbs",
        "Aero platform floats more at speed, less consistent downforce",
        "Risk of harsh bottoming if you're running very low"
      ],
      "compensations": [
        {
          "id": "rideHeightF",
          "text": "Raise slightly if the floor is slamming down on compressions"
        }
      ]
    },
    "linked": [
      {
        "id": "rideHeightF",
        "reason": "Ride height decides when the stops engage"
      },
      {
        "id": "springF",
        "reason": "Total wheel rate = spring + engaged bumpstop"
      },
      {
        "id": "dampers",
        "reason": "Fast damping and stops both manage big hits"
      }
    ],
    "note": "If the balance changes *suddenly* at one speed or one compression, suspect a bumpstop engaging."
  },
  {
    "id": "brakeBias",
    "group": "Brakes",
    "name": "Brake bias",
    "upLabel": "Forward",
    "downLabel": "Rearward",
    "does": "Splits braking force front/rear. The fastest balance change in the car. And the one you can adjust from the wheel mid-stint. Its effect is speed-sensitive, because at high speed the wing is pressing the rear down.",
    "up": {
      "effects": [
        "Stable, predictable braking; the rear stays in line",
        "Front lockup risk rises, especially as the fronts wear",
        "Understeer on corner entry under trail-braking. The car resists rotation"
      ],
      "compensations": [
        {
          "id": "electronics",
          "text": "On LMGT3, select an ABS map suited to the car before tuning bias; map numbers are not a universal intervention scale"
        },
        {
          "id": "arbF",
          "text": "Softer front bar restores some entry rotation"
        }
      ]
    },
    "down": {
      "effects": [
        "Car rotates into the corner under trail-braking, great for hairpins",
        "Rear lockup / snap risk under hard braking, worst at low speed where the wing isn't helping",
        "Less margin in panic stops and on cold tyres"
      ],
      "compensations": [
        {
          "id": "rearWing",
          "text": "More wing makes rearward bias safer at speed (but not in slow corners)"
        },
        {
          "id": "electronics",
          "text": "On LMGT3, evaluate the chosen ABS map and rearward bias separately; increasing the map number is not a universal safety net"
        }
      ]
    },
    "linked": [
      {
        "id": "rearWing",
        "reason": "Rear downforce sets how much braking the rear can take. Bias and wing move together"
      },
      {
        "id": "electronics",
        "reason": "The selected ABS map and brake bias interact; changing both together can cause instability"
      },
      {
        "id": "diffPreload",
        "reason": "Off-throttle diff locking also shapes entry rotation, they stack"
      }
    ],
    "note": "Tune in small increments and reassess after representative laps; no universal bias window is claimed."
  },
  {
    "id": "brakePressure",
    "group": "Brakes",
    "name": "Brake pressure",
    "upLabel": "Higher",
    "downLabel": "Lower",
    "does": "Sets how pedal travel reaches the calipers. Suitable pressure depends on the car, its ABS capability, tyre grip and pedal input; confirm behaviour in-game.",
    "up": {
      "effects": [
        "Higher pressure can increase braking force while tyre grip permits",
        "Without ABS, higher pressure can increase lockup risk, especially as aerodynamic load changes through braking",
        "Less modulation. The pedal becomes an on/off switch rather than a dial"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "If pressure changes, recheck front/rear balance and lock behaviour."
        },
        {
          "id": "electronics",
          "text": "ABS behaviour and pressure response vary by car; verify in-game."
        }
      ]
    },
    "down": {
      "effects": [
        "More modulation. A usable range under your foot instead of a cliff edge",
        "Lower pressure can improve modulation and reduce lock risk; verify the useful level in-game",
        "Slightly longer stops if you go too low. You are leaving clamping force on the table"
      ],
      "compensations": [
        {
          "id": "brakeMigration",
          "text": "On cars exposing migration, assess pressure and migration together during a stop."
        },
        {
          "id": "brakeBias",
          "text": "Lower pressure lets you run slightly more rearward bias without the snap"
        }
      ]
    },
    "linked": [
      {
        "id": "electronics",
        "reason": "ABS capability changes how pressure affects lockup"
      },
      {
        "id": "brakeBias",
        "reason": "Pressure sets how hard you can brake, bias sets where. They are one system"
      },
      {
        "id": "brakeMigration",
        "reason": "Migration shifts bias through the stop as the wing fades; pressure decides whether the fronts survive that shift"
      }
    ],
    "note": "Brake pressure depends on car capability, track, tyre state and pedal input. Treat community advice as a prompt to evaluate in-game, not a target."
  },
  {
    "id": "brakeDucts",
    "group": "Brakes",
    "name": "Brake ducts",
    "upLabel": "More open",
    "downLabel": "More closed",
    "does": "Cooling for discs and pads. But their stealth role is tyre pressure control, because brake heat soaks through the rim into the air in the tyre.",
    "up": {
      "effects": [
        "Cooler brakes: consistent pedal, less pad wear over a stint",
        "Tyre pressures settle lower as the rims run cooler (the exact kPa per step varies by car)",
        "A little more drag; brakes and tyres take longer to warm up"
      ],
      "compensations": [
        {
          "id": "pressure",
          "text": "Raise cold pressures to land in the same hot window"
        }
      ]
    },
    "down": {
      "effects": [
        "Faster warm-up. Good for short stints, qualifying and cold tracks",
        "Pressures settle higher; fade and pad wear risk in long stints",
        "Slightly less drag"
      ],
      "compensations": [
        {
          "id": "pressure",
          "text": "Drop cold pressures to compensate for the extra rim heat"
        }
      ]
    },
    "linked": [
      {
        "id": "pressure",
        "reason": "Duct steps are effectively a pressure adjustment you can plan a stint around"
      },
      {
        "id": "brakeBias",
        "reason": "Brake temperature changes pedal feel and bite, which changes how a given bias behaves"
      }
    ],
    "note": "Duct (and radiator) openings are one of the few \"free\" tools for managing temperatures and pressures without touching the rest of the setup. LMU also exposes brake duct blanking front and rear."
  },
  {
    "id": "diffPreload",
    "group": "Drivetrain & electronics",
    "name": "Differential preload",
    "upLabel": "More",
    "downLabel": "Less",
    "does": "How strongly the diff resists a speed difference between the rear wheels before torque is even applied. It shapes the car in the *transitions*. Off-throttle into the corner, and the moment you pick the throttle back up.",
    "up": {
      "effects": [
        "More locked off-throttle: stable, planted entry that resists rotation (entry understeer)",
        "Stronger, more connected drive on throttle pickup",
        "On tight exits the locked axle can push wide. Or snap if grip runs out",
        "Smoother across throttle transitions overall"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "A touch rearward bias restores entry rotation the preload took away"
        },
        {
          "id": "arbF",
          "text": "Softer front bar also brings back rotation, mid-corner instead of entry"
        }
      ]
    },
    "down": {
      "effects": [
        "Car rotates freely off-throttle, agile, eager entries",
        "Throttle pickup feels looser; inside wheel spins up easier out of slow corners",
        "Can feel nervous in fast lift-off moments"
      ],
      "compensations": [
        {
          "id": "electronics",
          "text": "A click more TC covers the looser throttle pickup"
        },
        {
          "id": "springR",
          "text": "Slightly softer rear springs add traction to compensate"
        }
      ]
    },
    "linked": [
      {
        "id": "brakeBias",
        "reason": "Both shape entry rotation. Set them as a pair"
      },
      {
        "id": "electronics",
        "reason": "TC and the diff fight over the same wheelspin"
      },
      {
        "id": "arbR",
        "reason": "Rear roll stiffness changes how loaded each rear wheel is, which changes what the diff sees"
      }
    ],
    "note": "Test preload in the slowest corner on the track. That's where its character is loudest."
  },
  {
    "id": "diffPower",
    "group": "Drivetrain & electronics",
    "name": "Differential power",
    "upLabel": "More lock",
    "downLabel": "Less lock",
    "does": "How hard the rear diff locks under throttle. Preload sets the baseline; power lock adds to it the harder you accelerate. Locked, the diff drives the loaded outside rear harder than the inside one, and that difference swings the car round, most noticeably in first to third gear corners. Some cars show it as a ramp angle, where a lower angle locks more.",
    "up": {
      "effects": [
        "Car rotates more on throttle: the outside rear drives it round",
        "Inside rear stops spinning up on its own",
        "Rear can step out as the power goes down, especially in slow corners",
        "Strong, connected drive once the car is straight"
      ],
      "compensations": [
        {
          "id": "electronics",
          "text": "A click more TC catches the rear if it now steps out on exit"
        },
        {
          "id": "springR",
          "text": "Slightly softer rear springs help the rear hook up again"
        }
      ]
    },
    "down": {
      "effects": [
        "Calmer, more stable exits: the rear stays behind you",
        "Car rotates less on throttle and can push wide on tight exits",
        "Inside rear can spin up on its own out of slow corners"
      ],
      "compensations": [
        {
          "id": "diffPreload",
          "text": "A touch more preload stops the inside wheel spinning alone"
        },
        {
          "id": "arbF",
          "text": "A softer front bar helps the nose keep turning on power"
        }
      ]
    },
    "linked": [
      {
        "id": "diffPreload",
        "reason": "Preload is the baseline lock and power adds to it under throttle, so read them together"
      },
      {
        "id": "electronics",
        "reason": "TC and the diff are both managing wheelspin, so set them as a pair"
      },
      {
        "id": "diffCoast",
        "reason": "Coast shapes the entry, power the exit. Change one and re-check the other"
      }
    ],
    "note": "Judge it on the exit of the slowest corner on the track. If the car swings round as you open the throttle, take lock away; if it won't turn on power and the inside wheel spins alone, add some."
  },
  {
    "id": "diffCoast",
    "group": "Drivetrain & electronics",
    "name": "Differential coast",
    "upLabel": "More lock",
    "downLabel": "Less lock",
    "does": "How hard the rear diff locks off the throttle: braking, trail-braking and turn-in. More lock ties the rear wheels together and keeps the rear planted; less lets the car rotate into the corner. Some cars show it as a ramp angle, where a lower angle locks more.",
    "up": {
      "effects": [
        "Stable, planted rear under braking and turn-in",
        "Resists rotation on entry and can bring entry understeer",
        "Calmer over kerbs and bumps off the throttle"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "A touch of rearward bias gives back some entry rotation"
        },
        {
          "id": "arbF",
          "text": "A softer front bar helps the nose turn in"
        }
      ]
    },
    "down": {
      "effects": [
        "Car rotates more freely into the corner",
        "Rear can get nervous or snap under trail-braking",
        "Rewards a smooth release of the brake"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "Move bias forward a touch if the rear gets nervous under braking"
        },
        {
          "id": "brakeMigration",
          "text": "On Hypercars, migration can steady the rear as you trail off the brake"
        }
      ]
    },
    "linked": [
      {
        "id": "brakeBias",
        "reason": "Both shape how the car rotates on entry, so set them as a pair"
      },
      {
        "id": "diffPreload",
        "reason": "Preload is the baseline and coast lock adds to it off the throttle"
      },
      {
        "id": "diffPower",
        "reason": "Coast shapes the entry, power the exit"
      }
    ],
    "note": "Test it in a slow corner with a long braking zone. That is where coast lock shows most."
  },
  {
    "id": "electronics",
    "group": "Drivetrain & electronics",
    "name": "TC & ABS",
    "upLabel": "More TC intervention",
    "downLabel": "Less TC intervention",
    "does": "Traction control manages wheelspin through slip threshold, power cut and lateral slip-angle settings. Native ABS is limited to LMGT3; its maps tune particular behaviours, not a universal more/less intervention scale. Car electronics and optional driving assists are distinct.",
    "up": {
      "effects": [
        "Earlier or stronger TC intervention can make exits more repeatable",
        "Excessive TC power cut can cost exit speed",
        "Slip threshold, power cut and lateral slip target change different aspects of intervention",
        "Check the actual car's response rather than assuming all settings increase intervention in the same direction"
      ],
      "compensations": [
        {
          "id": "diffPreload",
          "text": "If you keep needing more TC, the real fix is often diff/springs at the rear"
        }
      ]
    },
    "down": {
      "effects": [
        "Less TC intervention exposes more of the car's traction behaviour",
        "Wheelspin can punish abrupt throttle inputs",
        "Sliding can increase tyre wear; assess telemetry and representative laps"
      ],
      "compensations": [
        {
          "id": "springR",
          "text": "Softer rear springs / ARB make low TC liveable"
        },
        {
          "id": "toe",
          "text": "A touch more rear toe-in steadies exits without electronic help"
        }
      ]
    },
    "linked": [
      {
        "id": "diffPreload",
        "reason": "Diff locking and TC manage the same exit wheelspin from opposite ends"
      },
      {
        "id": "brakeBias",
        "reason": "Choose a suitable LMGT3 ABS map before tuning brake bias; no universal numeric map direction is established"
      },
      {
        "id": "pressure",
        "reason": "Wheelspin and sliding can increase tyre temperature; TC settings alter when and how power is cut"
      }
    ],
    "note": "Evaluate TC slip threshold, power cut and slip angle separately. For LMGT3 ABS, use the official map diagram and in-game behaviour instead of treating a higher map number as more assistance."
  },
  {
    "id": "virtualEnergy",
    "group": "Energy & hybrid",
    "name": "Virtual Energy",
    "upLabel": "More energy",
    "downLabel": "Less energy",
    "does": "Virtual Energy is an allocation control where present. Its presence does not prove a car is hybrid; plan using the game display and measured consumption.",
    "up": {
      "effects": [
        "Larger permitted energy use per stint, provided the fuel load covers the plan",
        "The chosen NRG allocation affects pit-stop duration; it is not battery charge",
        "Fuel carried and energy allowance must both cover measured consumption"
      ],
      "compensations": [
        {
          "id": "fuelRatio",
          "text": "Plan fuel carried against the chosen NRG allowance; extra fuel adds weight without increasing that allowance"
        }
      ]
    },
    "down": {
      "effects": [
        "Smaller permitted energy use per stint; fuel weight depends on fuel carried, not NRG alone",
        "Less margin before exhausting the allowance and incurring a penalty",
        "Use measured consumption, lift-and-coast and short shifting to conserve energy"
      ],
      "compensations": [
        {
          "id": "fuelRatio",
          "text": "Match Fuel Ratio to the energy you actually carry so the two agree"
        }
      ]
    },
    "linked": [
      {
        "id": "fuelRatio",
        "reason": "Energy and fuel are two views of the same stint plan, set them together"
      },
      {
        "id": "regen",
        "reason": "Harvest restores hybrid battery charge, not the Virtual Energy stint allowance"
      }
    ],
    "note": "Virtual Energy may be present outside hybrid cars; do not infer hybrid capability from its presence."
  },
  {
    "id": "fuelRatio",
    "group": "Energy & hybrid",
    "name": "Fuel Ratio",
    "upLabel": "Richer / more",
    "downLabel": "Leaner / less",
    "does": "Fuel control meaning varies by car. Use in-game displayed fuel and measured consumption to plan a stint.",
    "up": {
      "effects": [
        "More litres on board: longer stint, more early-stint weight",
        "Heavier car blunts traction and braking slightly until it burns down",
        "Useful to cover an extra lap if strategy is marginal"
      ],
      "compensations": [
        {
          "id": "virtualEnergy",
          "text": "Use the displayed fuel and energy values to plan the stint."
        }
      ]
    },
    "down": {
      "effects": [
        "Lighter, faster car, qualifying trim",
        "Shorter stint; risk of running dry if you misjudge consumption",
        "The car comes alive as fuel burns off regardless. Plan for the lap-1 weight"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "A heavy fuel load shifts weight rearward slightly. You may want a touch more front bias early"
        }
      ]
    },
    "linked": [
      {
        "id": "virtualEnergy",
        "reason": "Litres and energy allocation describe the same stint, they must agree"
      }
    ],
    "note": "Always plan fuel from a real consumption figure (the in-game MFD or a test stint), not a guess."
  },
  {
    "id": "regen",
    "group": "Energy & hybrid",
    "name": "Regen level",
    "upLabel": "More harvest",
    "downLabel": "Less harvest",
    "does": "On a confirmed hybrid, regeneration converts braking energy into battery charge. Battery charge is separate from the Virtual Energy stint allowance. Axle and scale are car-specific; assess in-game response rather than assuming common values.",
    "up": {
      "effects": [
        "Refills the battery faster, supporting continued deployment; it does not refill the NRG allowance",
        "Adds engine/MGU braking at the harvest axle: can tug the balance under braking",
        "On front-axle-harvest cars, strong regen can nudge the nose into the corner",
        "Heat and wear into the harvest-axle tyres rise slightly"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "Re-check brake bias. Regen braking stacks on top of the friction brakes at that axle"
        },
        {
          "id": "motorMap",
          "text": "A stronger deploy map spends what the harvest brings in, balance the two"
        }
      ]
    },
    "down": {
      "effects": [
        "Cleaner, more neutral braking feel. Fewer hybrid effects on entry",
        "Less battery charge recovered; balance deployment and harvest while monitoring fuel and NRG separately",
        "Easier to drive consistently if the harvest braking was unsettling you"
      ],
      "compensations": [
        {
          "id": "virtualEnergy",
          "text": "Monitor the NRG allowance independently; carrying more NRG does not restore battery charge"
        }
      ]
    },
    "linked": [
      {
        "id": "motorMap",
        "reason": "Harvest fills the battery, the deploy map empties it. Set them as a pair"
      },
      {
        "id": "brakeBias",
        "reason": "Regen braking changes the effective bias at the harvest axle"
      },
      {
        "id": "virtualEnergy",
        "reason": "Regeneration replenishes battery charge, while NRG tracks the permitted combined energy use per stint"
      }
    ],
    "note": "Step sizes for regen vary by car (the scale is car-specific). Use the displayed in-game value; do not assume a shared scale."
  },
  {
    "id": "motorMap",
    "group": "Energy & hybrid",
    "name": "Electric motor map",
    "upLabel": "More deploy",
    "downLabel": "Less deploy",
    "does": LMU_OFFICIAL_MOTOR_MAP.summary,
    "up": {
      "effects": [
        "More battery deployment replaces a larger share of ICE torque; it does not increase combined power",
        "Battery charge is spent faster; balance deployment with harvest and monitor the state of charge",
        "Fuel consumption can fall as electric torque replaces combustion-engine torque",
        "Axle torque distribution and handling depend on the car and permitted deployment speed"
      ],
      "compensations": [
        {
          "id": "regen",
          "text": "Lift harvest to keep up with the faster drain"
        },
        {
          "id": "electronics",
          "text": "Reassess traction-control behaviour on the actual car when deployment changes axle torque distribution"
        }
      ]
    },
    "down": {
      "effects": [
        "Less battery deployment leaves more of the required output to the combustion engine",
        "Battery charge is spent more slowly; reduced deployment is not a universal slower-exit rule",
        "Less electric contribution can increase fuel consumption; check fuel and battery separately"
      ],
      "compensations": [
        {
          "id": "regen",
          "text": "Balance harvest with deployment while leaving battery capacity available for regeneration"
        }
      ]
    },
    "linked": [
      {
        "id": "regen",
        "reason": "Deploy and harvest are the two halves of the energy loop"
      },
      {
        "id": "virtualEnergy",
        "reason": "NRG limits combined energy use per stint; battery charge is a separate budget, not an extra NRG allocation"
      }
    ],
    "note": "Official LMU guidance describes deployment as fuel-efficiency management, not an extra-power boost. Read the car's displayed map and battery charge; no universal SVM click scale is established."
  },
  {
    "id": "frontDiff",
    "group": "Drivetrain & electronics",
    "name": "Front differential (Hypercar)",
    "upLabel": "More lock",
    "downLabel": "Less lock",
    "does": "Front-drive-axle Hypercars expose a front diff (power, coast and preload) on top of the rear. It shapes how the front axle puts down hybrid/engine torque and how it behaves trailing off the throttle. A handling tool the GT3s and LMPs don't have.",
    "up": {
      "effects": [
        "More front-axle locking: steadier front under power on deploy, but more understeer as both front wheels tie together",
        "Coast side: more locking calms the front entering a corked off-throttle",
        "Can mask front mechanical grip problems rather than fix them"
      ],
      "compensations": [
        {
          "id": "arbF",
          "text": "Soften the front ARB to recover the mid-corner rotation the lock takes away"
        },
        {
          "id": "motorMap",
          "text": "Front deploy and front diff interact. Re-check exit feel after changing either"
        }
      ]
    },
    "down": {
      "effects": [
        "Freer front axle: more rotation, livelier turn-in, but more torque-steer/instability under front deploy",
        "Less predictable on bumpy front-axle exits",
        "Rewards smooth throttle on the way out"
      ],
      "compensations": [
        {
          "id": "electronics",
          "text": "A click more TC steadies things while you test a freer front diff"
        }
      ]
    },
    "linked": [
      {
        "id": "diffPreload",
        "reason": "Front and rear diff behaviour combine into the overall on/off-throttle balance"
      },
      {
        "id": "motorMap",
        "reason": "On front-deploy cars, the diff decides how that power axle behaves"
      }
    ],
    "note": "Front-hybrid LMH cars (Ferrari 499P, Toyota GR010/TR010, Peugeot 9X8 and Isotta Tipo 6) drive through the front axle. LMDh and non-hybrid LMH cars do not. Check the setup's capability badge and field lock reason; a dummy front-diff value does not prove front-wheel drive."
  },
  {
    "id": "brakeMigration",
    "group": "Brakes",
    "name": "Brake migration",
    "upLabel": "More migration",
    "downLabel": "Less migration",
    "does": "Shifts brake bias forward as you bleed off the pedal through a braking zone. More front bias on initial hard braking, migrating rearward as you trail off. Lets you run a stable-on-initial, rotational-on-release brake feel that a single fixed bias can't.",
    "up": {
      "effects": [
        "More forward bias at the top of the brake zone: stable, lock-resistant initial braking",
        "As you trail off, bias moves rearward. Helps the car rotate towards the apex",
        "Too much can make the rear feel like it wakes up unexpectedly mid-release"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "Set your base bias first, then add migration for the trail-braking phase"
        }
      ]
    },
    "down": {
      "effects": [
        "Bias stays closer to fixed through the zone, simpler, more predictable",
        "Less help rotating the car on brake release",
        "Better if migration was making the rear nervous"
      ],
      "compensations": [
        {
          "id": "brakeBias",
          "text": "Without migration you may want a touch less base front bias for entry rotation"
        }
      ]
    },
    "linked": [
      {
        "id": "brakeBias",
        "reason": "Migration moves *around* your base bias, they're set together"
      },
      {
        "id": "electronics",
        "reason": "ABS changes how much migration you can run before the rear locks"
      }
    ],
    "note": "A little migration goes a long way. Add it in single clicks and feel the brake-release phase specifically. On a hybrid car, remember regen is also braking at the driven axle, so the two stack: LMDh regen adds rear effort, front-hybrid LMH regen adds front."
  },
  {
    "id": "thirdSpring",
    "group": "Suspension & dampers",
    "name": "3rd spring / heave (Hypercar/LMP)",
    "upLabel": "Stiffer",
    "downLabel": "Softer",
    "does": "A central heave element that resists both wheels compressing together (pure vertical / aero load) without affecting roll. Prototypes use it to hold the aero platform under high downforce while keeping the corner springs soft for mechanical grip. The corner springs and the 3rd spring are set independently. The 3rd is not L/R linked.",
    "up": {
      "effects": [
        "Holds ride height better under aero load at speed, more consistent downforce",
        "Less dive/squat from pure vertical loads (braking, crests) without stiffening roll",
        "Too stiff and the platform stops absorbing big vertical hits, skittish over crests"
      ],
      "compensations": [
        {
          "id": "springF",
          "text": "You can often keep the corner springs softer for mechanical grip, letting the 3rd hold the platform"
        },
        {
          "id": "bumpstops",
          "text": "3rd spring and packers both manage end-of-travel, set them together"
        }
      ]
    },
    "down": {
      "effects": [
        "More compliant over big vertical inputs. Better mechanical grip on bumps and crests",
        "Platform moves more at speed: aero height varies more through a fast corner",
        "May reach the packers/bumpstops sooner under heavy aero load"
      ],
      "compensations": [
        {
          "id": "rideHeightF",
          "text": "Check the car isn't dropping onto its bumpstops at speed with a softer heave"
        }
      ]
    },
    "linked": [
      {
        "id": "springF",
        "reason": "Corner springs handle roll + heave together; the 3rd spring handles heave only. They overlap on vertical loads"
      },
      {
        "id": "bumpstops",
        "reason": "Both manage how the platform behaves at the end of vertical travel"
      },
      {
        "id": "rideHeightF",
        "reason": "Heave stiffness changes how low the car runs dynamically at speed"
      }
    ],
    "note": "GT3s generally have no active 3rd spring (it reads N/A); it is primarily a prototype tool. View / Edit shows fields present in the setup and keeps third-element settings independent from corner linking."
  }
];
export const LMU_SYMPTOMS: readonly SymptomAdvice[] = [
  {
    "id": "entryUnder",
    "group": "Corner entry",
    "name": "Won't turn in (entry understeer)",
    "description": "You brake, turn, and the nose washes wide before the apex. Worst while you're still on the brakes.",
    "quick": "Cheapest test first: move brake bias a small amount rearward from the wheel. If it improves, the problem is your entry tools, not outright front grip.",
    "causes": [
      {
        "id": "brakeBias",
        "label": "Bias too far forward",
        "fix": "Move rearward in 0.5% steps. Frees the car to rotate under trail-braking"
      },
      {
        "id": "diffPreload",
        "label": "Diff preload too high",
        "fix": "Lower it. A locked diff resists rotation off-throttle"
      },
      {
        "id": "dampers",
        "label": "Front slow bump too stiff",
        "fix": "Soften so the nose can dive and load the fronts on turn-in"
      },
      {
        "id": "arbF",
        "label": "Front bar too stiff",
        "fix": "Soften a click. This helps mid-corner too"
      },
      {
        "id": "pressure",
        "label": "Fronts out of the window",
        "fix": "Check hot pressures before touching anything mechanical"
      }
    ]
  },
  {
    "id": "entrySnap",
    "group": "Corner entry",
    "name": "Rear snaps under trail-braking",
    "description": "The rear steps out as you brake and turn in together, the classic spin-at-corner-entry.",
    "quick": "Note where it happens. Fast corners point to aero; slow corners point to bias, diff or cold rears.",
    "causes": [
      {
        "id": "brakeBias",
        "label": "Bias too far rearward",
        "fix": "Test a small forward bias change for stability"
      },
      {
        "id": "regen",
        "label": "Regen too high (LMDh)",
        "fix": "On an LMDh, harvest is rear braking the bias slider doesn't show. A click less regen calms the rear on entry. Not a factor on non-hybrid cars"
      },
      {
        "id": "diffPreload",
        "label": "Preload too low",
        "fix": "More preload steadies the rear off-throttle"
      },
      {
        "id": "rearWing",
        "label": "Not enough rear downforce (fast corners only)",
        "fix": "Add a step of wing if it only happens at speed"
      },
      {
        "id": "pressure",
        "label": "Cold or low rear pressures",
        "fix": "Rears below the window can't take braking and turning at once"
      },
      {
        "id": "dampers",
        "label": "Rear rebound too stiff",
        "fix": "Soften so the rear stays planted as weight moves forward"
      }
    ]
  },
  {
    "id": "midUnder",
    "group": "Mid-corner",
    "name": "Understeer mid-corner, all speeds",
    "description": "The front washes out at steady throttle, slow and fast corners alike. A mechanical front grip shortage.",
    "quick": "\"All speeds\" is the key clue. If it were only fast corners, it would be aero. See the high-speed symptoms instead.",
    "causes": [
      {
        "id": "arbF",
        "label": "Front bar too stiff",
        "fix": "Soften. The cleanest mid-corner balance tool there is"
      },
      {
        "id": "camber",
        "label": "Not enough front camber",
        "fix": "More negative camber; check inner temps afterwards"
      },
      {
        "id": "springF",
        "label": "Front springs too stiff",
        "fix": "Soften for slow-corner grip (costs a little response)"
      },
      {
        "id": "pressure",
        "label": "Fronts over the window",
        "fix": "High pressures shrink the contact patch"
      }
    ]
  },
  {
    "id": "midOver",
    "group": "Mid-corner",
    "name": "Loose mid-corner, all speeds",
    "description": "The rear edges wide at steady state and you're constantly making small corrections.",
    "quick": "Same logic in reverse: everywhere = mechanical, fast corners only = aero.",
    "causes": [
      {
        "id": "arbR",
        "label": "Rear bar too stiff",
        "fix": "Soften a click"
      },
      {
        "id": "camber",
        "label": "Not enough rear camber",
        "fix": "More negative rear camber plants the rear mid-corner"
      },
      {
        "id": "toe",
        "label": "Not enough rear toe-in",
        "fix": "A touch more calms the rear everywhere"
      },
      {
        "id": "pressure",
        "label": "Rears over the window",
        "fix": "Check hot rears"
      }
    ]
  },
  {
    "id": "fastUnder",
    "group": "High-speed corners",
    "name": "Understeer only in fast corners",
    "description": "Fine in the slow stuff, but the nose pushes in quick corners. An aero balance problem.",
    "quick": "Confirm it really is speed-dependent before touching aero. One slow corner with push disqualifies this diagnosis.",
    "causes": [
      {
        "id": "rideHeightF",
        "label": "Not enough rake",
        "fix": "Lower the front (or raise the rear) to pull aero balance forward"
      },
      {
        "id": "frontSplitter",
        "label": "Splitter setting too low",
        "fix": "Add a step if your car has one"
      },
      {
        "id": "rearWing",
        "label": "Too much wing",
        "fix": "Trim a step. You gain top speed as a bonus"
      }
    ]
  },
  {
    "id": "fastOver",
    "group": "High-speed corners",
    "name": "Nervous or loose at high speed",
    "description": "No confidence in fast corners; the rear feels light over crests and quick direction changes.",
    "quick": "If the balance changes suddenly at one specific compression, suspect a bumpstop engaging rather than pure aero.",
    "causes": [
      {
        "id": "rearWing",
        "label": "Not enough wing",
        "fix": "Add a step. The single biggest fix for this"
      },
      {
        "id": "rideHeightR",
        "label": "Too much rake",
        "fix": "Lower the rear a touch"
      },
      {
        "id": "bumpstops",
        "label": "Rear riding its stops",
        "fix": "More range or softer rate at the rear"
      },
      {
        "id": "dampers",
        "label": "Fast damping too stiff over crests",
        "fix": "Soften fast bump/rebound"
      }
    ]
  },
  {
    "id": "exitSpin",
    "group": "Corner exit",
    "name": "Wheelspin / loose on throttle",
    "description": "The rear breaks away as you feed in power out of slow and medium corners.",
    "quick": "Watch the replay: inside wheel spinning alone points at the diff; both wheels points at rear grip.",
    "causes": [
      {
        "id": "springR",
        "label": "Rear too stiff",
        "fix": "Soften the springs for traction"
      },
      {
        "id": "arbR",
        "label": "Rear bar too stiff",
        "fix": "Soften. Keeps the inside rear planted"
      },
      {
        "id": "diffPreload",
        "label": "Inside wheel lighting up",
        "fix": "More preload locks the axle and stops single-wheel spin"
      },
      {
        "id": "toe",
        "label": "Not enough rear toe-in",
        "fix": "Add a little for calmer exits"
      },
      {
        "id": "electronics",
        "label": "TC too low for the setup",
        "fix": "One click more while you fix the mechanical cause"
      }
    ]
  },
  {
    "id": "exitPush",
    "group": "Corner exit",
    "name": "Pushes wide on throttle (power understeer)",
    "description": "The front gives up the moment you accelerate. You run out of road on exit.",
    "quick": "Common on tight exits with high preload: the locked diff simply wants to drive straight.",
    "causes": [
      {
        "id": "diffPreload",
        "label": "Preload too high",
        "fix": "Lower it. Frees the car to keep rotating under power"
      },
      {
        "id": "springR",
        "label": "Rear too soft (squat lifts the nose)",
        "fix": "Slightly stiffer rear keeps the front loaded on throttle"
      },
      {
        "id": "electronics",
        "label": "TC over-set",
        "fix": "Heavy TC can feel like push. Try a click less"
      }
    ]
  },
  {
    "id": "frontLock",
    "group": "Braking zones",
    "name": "Front lockups",
    "description": "One or both fronts lock under hard braking, flat-spotting tyres and lengthening stops.",
    "quick": "Lockups that only appear late in a stint are usually tyre wear, not setup. Check before changing anything.",
    "causes": [
      {
        "id": "brakePressure",
        "label": "Pressure too high for a no-ABS car",
        "fix": "Evaluate approximately 5% less brake pressure in-game; no click conversion is established."
      },
      {
        "id": "brakeBias",
        "label": "Bias too far forward",
        "fix": "Test a small rearward bias change"
      },
      {
        "id": "regen",
        "label": "Regen loading the fronts (front-hybrid LMH)",
        "fix": "Ferrari, Toyota and Peugeot harvest through the front axle. Heavy regen is extra front braking. A click less can stop the lockups without touching bias"
      },
      {
        "id": "electronics",
        "label": "Unsuitable ABS map on an LMGT3 car",
        "fix": "Use the official car-map guidance and choose a suitable map before adjusting brake bias; one click up is not a universal increase in intervention"
      },
      {
        "id": "brakeDucts",
        "label": "Discs out of their temp window",
        "fix": "Adjust ducts. Cold and overheated brakes both bite unevenly"
      },
      {
        "id": "camber",
        "label": "Too much front camber",
        "fix": "Less camber enlarges the upright, straight-line contact patch"
      }
    ]
  },
  {
    "id": "kerbLaunch",
    "group": "Kerbs & bumps",
    "name": "Launched or unsettled by kerbs",
    "description": "The car skips, hops or gets thrown off line when you take kerbs you ought to be able to use.",
    "quick": "Kerb behaviour is almost entirely fast damping + bumpstops + ride height. Springs and bars are rarely the culprit.",
    "causes": [
      {
        "id": "dampers",
        "label": "Fast damping too stiff",
        "fix": "Soften fast bump/rebound so the wheel can swallow the kerb"
      },
      {
        "id": "bumpstops",
        "label": "Stops too stiff or too short",
        "fix": "Softer rate or more range"
      },
      {
        "id": "rideHeightF",
        "label": "Running too low",
        "fix": "A couple of millimetres higher buys real compliance"
      }
    ]
  },
  {
    "id": "bumpUnder",
    "group": "Kerbs & bumps",
    "name": "Sudden understeer over bumps at speed",
    "description": "Fine on smooth tarmac, but the front washes out the instant it hits a compression or bump mid-corner.",
    "quick": "This is the signature of the front bumpstops engaging. The platform hits a wall and the tyre unloads.",
    "causes": [
      {
        "id": "bumpstops",
        "label": "Front stops engaging harshly",
        "fix": "Softer rate or more range at the front"
      },
      {
        "id": "rideHeightF",
        "label": "Front too low",
        "fix": "Raise 1–2 mm so compressions don't bottom it"
      },
      {
        "id": "springF",
        "label": "Springs too soft for the ride height",
        "fix": "Stiffer fronts hold the car off the stops"
      }
    ]
  },
  {
    "id": "hotPressures",
    "group": "Tyres over a stint",
    "name": "Pressures climb out of the window",
    "description": "Perfect on lap 3, over the window by lap 12. Grip fades and the car gets snappy as the stint goes on.",
    "quick": "Set up for mid-stint, not lap 1: start slightly under the window and let the stint bring them in.",
    "causes": [
      {
        "id": "pressure",
        "label": "Cold pressures set too high",
        "fix": "Adjust from measured hot tyre behaviour"
      },
      {
        "id": "brakeDucts",
        "label": "Ducts too closed",
        "fix": "One step more open bleeds heat out of the rims"
      },
      {
        "id": "toe",
        "label": "Too much scrub",
        "fix": "Excess toe is a constant heat source"
      },
      {
        "id": "electronics",
        "label": "Sliding generating heat",
        "fix": "If you're fighting the car, fix the balance, sliding cooks tyres"
      }
    ]
  },
  {
    "id": "coldTyres",
    "group": "Tyres over a stint",
    "name": "Can't get heat in (quali / cold track)",
    "description": "Tyres take too long to switch on. The first laps are skating and the window never quite arrives.",
    "quick": "Mostly a qualifying and cold-conditions problem; don't compromise a race setup for it.",
    "causes": [
      {
        "id": "brakeDucts",
        "label": "Ducts too open",
        "fix": "Close a step. Brake heat is your tyre warmer"
      },
      {
        "id": "pressure",
        "label": "Colds set too low for conditions",
        "fix": "Raise colds so the window arrives sooner"
      },
      {
        "id": "camber",
        "label": "Tyre not working hard enough",
        "fix": "A touch more camber and toe puts energy into the tread"
      }
    ]
  },
  {
    "id": "hybridBrake",
    "group": "Braking zones",
    "name": "Unsettled braking on a hybrid (regen feel)",
    "description": "On a confirmed hybrid, regen may alter braking feel, with axle effects depending on architecture.",
    "quick": "Regen braking stacks on the friction brakes at the harvest axle. Lower regen a step and see if the braking feel cleans up. Then decide if you can afford the lost energy.",
    "causes": [
      {
        "id": "regen",
        "label": "Harvest too aggressive",
        "fix": "Lower regen a step for a cleaner, more neutral brake feel"
      },
      {
        "id": "brakeBias",
        "label": "Bias not accounting for regen",
        "fix": "Re-set bias with regen at race level. The harvest axle is effectively braking harder"
      },
      {
        "id": "brakeMigration",
        "label": "Migration stacking with regen",
        "fix": "Ease migration if the rear wakes up oddly as you release the pedal"
      }
    ]
  },
  {
    "id": "energyShort",
    "group": "Tyres over a stint",
    "name": "Running out of energy / fuel before the stop",
    "description": "You don't reach the planned lap or the next stop. The energy or fuel allocation is short for how you're driving.",
    "quick": "Identify which quantity is short: fuel, Virtual Energy allowance, or hybrid battery charge. Plan fuel and NRG from measured consumption; use lift-and-coast or short shifting to save energy.",
    "causes": [
      {
        "id": "virtualEnergy",
        "label": "Allocation set too low",
        "fix": "Review allocation if present; do not infer hybrid capability from Virtual Energy"
      },
      {
        "id": "fuelRatio",
        "label": "Not enough fuel for the stint",
        "fix": "Raise Fuel Ratio / litres to cover the laps"
      },
      {
        "id": "motorMap",
        "label": "Battery deployment exceeds available charge",
        "fix": "Balance deployment with harvest to preserve battery charge. Less deployment can increase fuel use; it does not automatically extend the NRG allowance."
      },
      {
        "id": "regen",
        "label": "Too little battery charge recovered",
        "fix": "Balance regen with deployment and leave battery capacity available to accept harvest. Regen refills the battery, not the NRG allowance."
      }
    ]
  },
  {
    "id": "frontDiffEntry",
    "group": "Corner entry",
    "name": "Front-deploy car unstable on entry/exit",
    "description": "Hypercar with a driven front axle. The front feels nervous or torque-steers as power deploys, or won't settle on a bumpy entry.",
    "quick": "Front-axle Hypercars have their own front diff. If only some cars do this, it's likely the front diff/deploy interaction, not the rear.",
    "causes": [
      {
        "id": "frontDiff",
        "label": "Front diff too free",
        "fix": "More front locking steadies the front under deploy"
      },
      {
        "id": "frontDiff",
        "label": "Front diff too locked",
        "fix": "Less locking frees rotation if it's pushing wide"
      },
      {
        "id": "motorMap",
        "label": "Front deploy too aggressive",
        "fix": "A gentler map calms front-axle power delivery"
      }
    ]
  }
];
export const LMU_PRESET_ADVICE: readonly PresetAdvice[] = [
  {
    "id": "entry_under",
    "group": "entry",
    "name": "Less understeer on entry",
    "description": "Frees the car to rotate under trail-braking.",
    "noAbs": false,
    "targets": [
      {
        "section": "CONTROLS",
        "key": "RearBrakeSetting",
        "label": "Shift brake bias rearward. The entry rotation tool",
        "delta": 1
      },
      {
        "section": "DRIVELINE",
        "key": "DiffCoastSetting",
        "label": "Less coast diff lock off-throttle",
        "delta": -1
      },
      {
        "section": "SUSPENSION",
        "key": "FrontAntiSwaySetting",
        "label": "Softer front bar for mid-corner support",
        "delta": -1
      }
    ]
  },
  {
    "id": "entry_snap",
    "group": "entry",
    "name": "Calmer rear on entry",
    "description": "Steadies a rear that steps out under trail-braking.",
    "noAbs": false,
    "targets": [
      {
        "section": "CONTROLS",
        "key": "RearBrakeSetting",
        "label": "Shift brake bias forward for braking stability",
        "delta": -1
      },
      {
        "section": "DRIVELINE",
        "key": "DiffCoastSetting",
        "label": "More coast lock steadies the rear off-throttle",
        "delta": 1
      }
    ]
  },
  {
    "id": "brake_lock",
    "group": "entry",
    "name": "Locking the fronts under braking",
    "description": "For cars without ABS: evaluate approximately 5% less brake pressure in-game. No click conversion is established.",
    "noAbs": true,
    "targets": [
      {
        "section": "CONTROLS",
        "key": "BrakePressureSetting",
        "label": "Approximately 5% less pressure to evaluate in-game; no click conversion is established",
        "delta": null
      }
    ]
  },
  {
    "id": "mid_under",
    "group": "mid",
    "name": "Less understeer mid-corner",
    "description": "More mechanical front grip at all speeds.",
    "noAbs": false,
    "targets": [
      {
        "section": "SUSPENSION",
        "key": "FrontAntiSwaySetting",
        "label": "The cleanest mid-corner balance tool",
        "delta": -1
      },
      {
        "section": "FRONTLEFT",
        "key": "SpringSetting",
        "label": "Softer front spring (L/R linked)",
        "delta": -1
      }
    ]
  },
  {
    "id": "mid_over",
    "group": "mid",
    "name": "Less oversteer mid-corner",
    "description": "Calms a rear that edges wide at steady state.",
    "noAbs": false,
    "targets": [
      {
        "section": "SUSPENSION",
        "key": "RearAntiSwaySetting",
        "label": "Softer rear bar",
        "delta": -1
      },
      {
        "section": "REARLEFT",
        "key": "SpringSetting",
        "label": "Softer rear spring (L/R linked)",
        "delta": -1
      }
    ]
  },
  {
    "id": "fast_under",
    "group": "fast",
    "name": "Less understeer in fast corners",
    "description": "Pulls aero balance forward, speed-dependent fix.",
    "noAbs": false,
    "targets": [
      {
        "section": "REARWING",
        "key": "RWSetting",
        "label": "A step less wing (top speed bonus)",
        "delta": -1
      },
      {
        "section": "FRONTLEFT",
        "key": "RideHeightSetting",
        "label": "Lower front = more rake = more front aero",
        "delta": -1
      }
    ]
  },
  {
    "id": "fast_over",
    "group": "fast",
    "name": "More stability in fast corners",
    "description": "Pushes aero balance rearward for confidence at speed.",
    "noAbs": false,
    "targets": [
      {
        "section": "REARWING",
        "key": "RWSetting",
        "label": "A step more wing. The biggest single fix",
        "delta": 1
      },
      {
        "section": "REARLEFT",
        "key": "RideHeightSetting",
        "label": "Slightly less rake",
        "delta": -1
      }
    ]
  },
  {
    "id": "top_speed",
    "group": "fast",
    "name": "More top speed",
    "description": "For long straights like Monza. One click less wing. If the rear goes light at speed, lower the rear a touch to take out some rake.",
    "noAbs": false,
    "targets": [
      {
        "section": "REARWING",
        "key": "RWSetting",
        "label": "One click less rear wing: less drag, less rear grip in fast corners",
        "delta": -1
      }
    ]
  },
  {
    "id": "traction",
    "group": "exit",
    "name": "More traction on exit",
    "description": "Helps the rear hook up out of slow corners.",
    "noAbs": false,
    "targets": [
      {
        "section": "REARLEFT",
        "key": "SpringSetting",
        "label": "Softer rear spring (L/R linked)",
        "delta": -1
      },
      {
        "section": "SUSPENSION",
        "key": "RearAntiSwaySetting",
        "label": "Softer rear bar keeps the inside rear planted",
        "delta": -1
      },
      {
        "section": "DRIVELINE",
        "key": "DiffPowerSetting",
        "label": "Less power lock calms the rear stepping out as the power goes down",
        "delta": -1
      }
    ]
  },
  {
    "id": "power_push",
    "group": "exit",
    "name": "Less push on throttle",
    "description": "For a front that gives up the moment you accelerate.",
    "noAbs": false,
    "targets": [
      {
        "section": "DRIVELINE",
        "key": "DiffPowerSetting",
        "label": "More power lock drives the outside rear harder and helps the car rotate on throttle",
        "delta": 1
      },
      {
        "section": "REARLEFT",
        "key": "SpringSetting",
        "label": "Stiffer rear spring limits squat lifting the nose",
        "delta": 1
      }
    ]
  },
  {
    "id": "hybrid_brake",
    "group": "hybrid",
    "name": "Unsettled braking on a hybrid",
    "description": "Regen tugs the car as you trail off the brake.",
    "noAbs": false,
    "targets": [
      {
        "section": "ENGINE",
        "key": "RegenerationMapSetting",
        "label": "Lower regen for a cleaner brake feel",
        "delta": -1
      }
    ]
  },
  {
    "id": "energy_short",
    "group": "hybrid",
    "name": "Managing hybrid battery charge",
    "description": "Balance deployment and harvest when battery charge is short. Fuel and NRG stint planning are separate; less deployment is not a universal fuel-saving fix.",
    "noAbs": false,
    "targets": [
      {
        "section": "ENGINE",
        "key": "ElectricMotorMapSetting",
        "label": "Less deployment spends battery charge more slowly; check the effect on fuel consumption",
        "delta": -1
      },
      {
        "section": "ENGINE",
        "key": "RegenerationMapSetting",
        "label": "More harvest refills the battery, provided it is not already full; it does not refill NRG",
        "delta": 1
      }
    ]
  }
];
function gate(id:string, document:SvmDocument|null):AdviceAvailability {
  if (!document) return {available:false,reason:"Select a setup for car-specific applicability."};
  const caps=getSvmCapabilities(document);
  if (["regen","motorMap","hybridBrake","hybrid_brake","energy_short","frontRegen"].includes(id) && caps.hybrid!==true) return {available:false,reason:caps.hybrid===false?"This car is not hybrid.":"Hybrid capability is unknown for this car."};
  if (["frontDiff","frontDiffEntry","frontRegen"].includes(id) && caps.frontDrive!==true) return {available:false,reason:caps.frontDrive===false?"This car does not have front drive.":"Front-drive capability is unknown for this car."};
  if (id==="brake_lock" && caps.abs!==false) return {available:false,reason:caps.abs===true?"This advice is only for cars without ABS.":"ABS capability is unknown for this car."};
  if (id==="entrySnapRegen" && caps.architecture!=="lmdh") return {available:false,reason:caps.architecture==="unknown"?"Hybrid architecture is unknown for this car.":"Regen advice applies only to LMDh cars."};
  return {available:true,reason:null};
}
export function getParameterAdvice(document:SvmDocument|null):AdviceItem<ParameterAdvice>[] { return LMU_PARAMETERS.map(item=>({item,availability:gate(item.id,document)})); }
export function getSymptomAdvice(document:SvmDocument|null):AdviceItem<Omit<SymptomAdvice,"causes">&{causes:AdviceCause[]}>[] { return LMU_SYMPTOMS.map(item=>({item:{...item,causes:item.causes.map(cause=>({...cause,availability:gate(item.id==="entrySnap"&&cause.id==="regen"?"entrySnapRegen":item.id==="frontLock"&&cause.id==="regen"?"frontRegen":item.id==="frontLock"&&cause.id==="brakePressure"?"brake_lock":cause.id,document)}))},availability:gate(item.id,document)})); }
export function getPresetAdvice(document:SvmDocument|null):AdviceItem<Omit<PresetAdvice,"targets">&{targets:AdvicePresetTarget[]}>[] { return LMU_PRESET_ADVICE.map(item=>{const targets=item.targets.map(target=>{let availability=item.noAbs?gate("brake_lock",document):gate(item.id,document);if(!document)return {...target,availability};const access=getSvmFieldAccess(document,`${target.section}.${target.key}`);if(access.editable&&target.delta!==null){const setting=document.settings.get(`${target.section}.${target.key}`)!;const result=setting.index+target.delta;if(!Number.isSafeInteger(result)||result<0)availability={available:false,reason:"Preset change would produce an invalid setting index."}}return {...target,availability:access.editable?availability:{available:false,reason:access.reason}}});const unavailable=targets.find(target=>!target.availability.available);const applicable=targets.some(target=>target.availability.available);const availability=applicable?{available:true,reason:null}:unavailable?.availability??gate(item.id,document);return {item:{...item,targets},availability}}); }
