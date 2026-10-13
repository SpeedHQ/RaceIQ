import { useState } from "react";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { getLmuGuideContent } from "./lmu-guide-content";
import { LmuGuideIllustration } from "./LmuGuideIllustration";

export interface LmuSetupGuideProps {
  parameterId?: string | null;
  onParameterChange?: (id: string) => void;
}

const AXLE_TOPIC: Record<string, string> = {
  rideHeightF: "rideHeight",
  rideHeightR: "rideHeight",
  springF: "springs",
  springR: "springs",
  arbF: "antiRollBars",
  arbR: "antiRollBars",
};

export function LmuSetupGuide({ parameterId, onParameterChange }: LmuSetupGuideProps) {
  const [view, setView] = useState<"parameters" | "symptoms">("parameters");
  const [localParameter, setLocalParameter] = useState("pressure");
  const [symptomId, setSymptomId] = useState<string | null>(null);
  const { parameters, symptoms, officialTopics } = getLmuGuideContent();
  const topicNames: Record<string, string> = {
    rideHeight: m.lmu_setup_field_ride_height(),
    springs: m.tune_section_springs(),
    antiRollBars: m.tune_section_anti_roll_bars(),
  };
  const topics = parameters
    .filter((item) => item.id !== "rideHeightR" && item.id !== "springR" && item.id !== "arbR")
    .map((item) => {
      const id = AXLE_TOPIC[item.id] ?? item.id;
      return {
        id,
        name: topicNames[id] ?? item.name,
        group: item.group,
        parameters: parameters.filter((candidate) => (AXLE_TOPIC[candidate.id] ?? candidate.id) === id),
      };
    });
  const selectedId = parameterId ?? localParameter;
  const topic = topics.find((item) => item.id === (AXLE_TOPIC[selectedId] ?? selectedId)) ?? topics[0]!;
  const symptom = symptoms.find((item) => item.id === symptomId) ?? symptoms[0]!;
  const groups = [...new Set(topics.map((item) => item.group))];
  const focus = (id: string) => {
    setLocalParameter(id);
    setView("parameters");
    onParameterChange?.(id);
  };
  const name = (id: string) => parameters.find((item) => item.id === id)?.name;

  return (
    <div className="flex flex-col gap-4 text-app-body leading-relaxed">
      <p className="max-w-4xl text-app-text-muted">{m.lmu_guide_intro()}</p>
      <div className="flex gap-4 border-b border-app-border" role="group" aria-label={m.lmu_guide_choose_topic()}>
        <Button variant="app-ghost" className={`border-b-2 px-0 ${view === "parameters" ? "border-b-app-accent text-app-accent" : "border-b-transparent"}`} aria-pressed={view === "parameters"} onClick={() => setView("parameters")}>
          {m.lmu_guide_parameters()}
        </Button>
        <Button variant="app-ghost" className={`border-b-2 px-0 ${view === "symptoms" ? "border-b-app-accent text-app-accent" : "border-b-transparent"}`} aria-pressed={view === "symptoms"} onClick={() => setView("symptoms")}>
          {m.lmu_guide_symptoms()}
        </Button>
      </div>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label={m.lmu_guide_choose_topic()} className="max-h-80 overflow-auto border-b border-app-border pb-4 lg:max-h-none lg:border-b-0 lg:border-r lg:pr-4">
          {view === "parameters"
            ? groups.map((group) => (
                <section key={group} className="mb-4 last:mb-0">
                  <h2 className="mb-1 text-app-subtext font-semibold text-app-text-muted">{group}</h2>
                  {topics
                    .filter((item) => item.group === group)
                    .map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        aria-current={item.id === topic.id ? "page" : undefined}
                        onClick={() => focus(item.id)}
                        className={`block w-full border-l-2 px-3 py-2 text-left text-app-subtext hover:text-app-accent focus-visible:outline-2 focus-visible:outline-app-accent ${item.id === topic.id ? "border-app-accent font-semibold text-app-accent" : "border-transparent text-app-text"}`}
                      >
                        {item.name}
                      </button>
                    ))}
                </section>
              ))
            : symptoms.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-current={item.id === symptom.id ? "page" : undefined}
                  onClick={() => setSymptomId(item.id)}
                  className={`block w-full border-l-2 px-3 py-2 text-left text-app-subtext hover:text-app-accent focus-visible:outline-2 focus-visible:outline-app-accent ${item.id === symptom.id ? "border-app-accent font-semibold text-app-accent" : "border-transparent text-app-text"}`}
                >
                  {item.name}
                </button>
              ))}
        </nav>
        {view === "parameters" ? (
          <article key={topic.id} id={`lmu-parameter-${topic.id}`} className="min-w-0 space-y-6">
            <header>
              <p className="text-app-subtext text-app-text-muted">{topic.group}</p>
              <h2 className="text-app-title">{topic.name}</h2>
            </header>
            <LmuGuideIllustration parameterId={topic.id} title={topic.name} description={topic.parameters.map((parameter) => parameter.does).join(" ")} />
            {topic.parameters.map((parameter) => (
              <section key={parameter.id} id={`lmu-parameter-section-${parameter.id}`} className={topic.id === "springs" ? "space-y-5 rounded-lg border border-app-border bg-app-surface p-4" : "space-y-5"}>
                {topic.parameters.length > 1 && <h3 className={`text-app-heading font-semibold ${topic.id === "springs" ? "" : "border-t border-app-border pt-4"}`}>{parameter.name}</h3>}
                <section>
                  <h3 className="mb-2 text-app-heading font-semibold">{m.lmu_guide_how_it_works()}</h3>
                  <p>{parameter.does}</p>
                  <p className="mt-2 text-app-text-muted">{parameter.note}</p>
                </section>
                {officialTopics
                  .filter((topic) => topic.parameterId === parameter.id)
                  .map((topic) => (
                    <section key={topic.id} className="space-y-2 border-l-2 border-status-info pl-4">
                      <h3 className="text-app-heading font-semibold">
                        {m.lmu_setup_official_docs()} · {topic.title}
                      </h3>
                      <p>{topic.summary}</p>
                      <ul className="list-disc space-y-1 pl-5">
                        {topic.facts.map((fact, index) => (
                          <li key={index}>{fact}</li>
                        ))}
                      </ul>
                      <ul className="text-app-subtext">
                        {topic.sources.map((source) => (
                          <li key={source.url}>
                            <a className="text-app-accent underline" href={source.url} target="_blank" rel="noreferrer">
                              {source.title}
                            </a>
                            {" · "}
                            {m.lmu_setup_source_reviewed({ date: source.reviewedAt })}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                <p className="text-app-subtext text-app-text-muted">{m.lmu_setup_community_starting_point()}</p>
                <div className="grid gap-6 xl:grid-cols-2">
                  {(["up", "down"] as const).map((direction) => (
                    <section key={direction} className="border-t border-app-border pt-4">
                      <h3 className="mb-2 text-app-heading font-semibold">{direction === "up" ? parameter.upLabel : parameter.downLabel}</h3>
                      <ul className="list-disc space-y-2 pl-5">
                        {parameter[direction].effects.map((effect, index) => (
                          <li key={index}>{effect}</li>
                        ))}
                      </ul>
                      {parameter[direction].compensations.map((entry, index) => (
                        <p key={index} className="mt-3">
                          <strong>{m.lmu_setup_compensation()}: </strong>
                          {entry.text}
                          {name(entry.id) && (
                            <Button variant="link" size="content" className="ml-1 text-app-body whitespace-normal text-left" onClick={() => focus(entry.id)}>
                              {name(entry.id)}
                            </Button>
                          )}
                        </p>
                      ))}
                    </section>
                  ))}
                </div>
                {parameter.linked.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-app-heading font-semibold">{m.lmu_guide_related()}</h3>
                    <ul className="space-y-2">
                      {parameter.linked.map((entry) => (
                        <li key={entry.id}>
                          {name(entry.id) && (
                            <Button variant="link" size="content" className="text-app-body whitespace-normal text-left" onClick={() => focus(entry.id)}>
                              {name(entry.id)}
                            </Button>
                          )}
                          <p className="text-app-text-muted">{entry.reason}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </section>
            ))}
          </article>
        ) : (
          <article key={symptom.id} className="min-w-0 space-y-6">
            <header>
              <p className="text-app-subtext text-app-text-muted">{symptom.group}</p>
              <h2 className="text-app-title">{symptom.name}</h2>
            </header>
            <LmuGuideIllustration parameterId={`symptom:${symptom.id}`} title={symptom.name} description={symptom.description} />
            <p>{symptom.description}</p>
            <p className="border-l-2 border-status-info pl-4">{symptom.quick}</p>
            <ol className="list-decimal space-y-4 pl-5">
              {symptom.causes.map((cause, index) => (
                <li key={index}>
                  <h3 className="text-app-heading font-semibold">{cause.label}</h3>
                  <p>{cause.fix}</p>
                  {name(cause.id) && (
                    <Button variant="link" size="content" className="text-app-body whitespace-normal text-left" onClick={() => focus(cause.id)}>
                      {m.lmu_setup_parameter_explanation()} · {name(cause.id)}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </article>
        )}
      </div>
    </div>
  );
}
