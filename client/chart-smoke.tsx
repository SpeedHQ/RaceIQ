import React from 'react'; import {createRoot} from 'react-dom/client'; import './src/index.css'; const getLocale=()=> 'en'; const m=new Proxy({}, {get:(_,key)=> (...args)=>key === 'home_insights_podiums_total' ? 'Podiums: '+args[0].total : String(key).replace('home_insights_','').replaceAll('_',' ')}); const HISTOGRAM_LABELS=['0','0.1','0.2','0.3','0.4','0.5','0.6','0.7','0.8','0.9']; const INSIGHT_PANEL_CLASS='rounded-lg border border-app-border bg-app-surface p-3'; const InsightInfo=()=>null; document.documentElement.classList.add('dark'); function PercentageTrendChart({ trend, label }: {
  trend: readonly { timestamp: number; rate: number; total: number }[];
  label: string;
}) {
  const first = trend[0];
  const last = trend[trend.length - 1];
  const span = first && last ? last.timestamp - first.timestamp : 0;
  const x = (time: number) => span === 0 ? 174 : 38 + (time - first!.timestamp) / span * 272;
  const y = (rate: number) => 88 - rate * 76;
  const dates = new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" });
  const times = new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" });
  return (
    <svg viewBox="0 0 320 112" preserveAspectRatio="none" className="mt-2 block h-28 w-full" role="group" aria-label={label}>
      <title>{label}</title>
      {[0, 0.5, 1].map((rate) => (
        <text key={rate} x="30" y={y(rate) + 3} textAnchor="end" fill="var(--app-text-muted)" className="font-mono text-app-caption">{rate * 100}%</text>
      ))}
      {trend.length > 0 && <polyline points={trend.map((point) => `${x(point.timestamp)},${y(point.rate)}`).join(" ")} fill="none" stroke="var(--app-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {trend.map((point, index) => {
        const pointLabel = `${times.format(point.timestamp)} · ${Math.round(point.rate * 100)}% · ${Math.round(point.rate * point.total)}/${point.total}`;
        return (
          <circle key={index} cx={x(point.timestamp)} cy={y(point.rate)} r={trend.length === 1 ? 3 : 2} fill="var(--app-accent)" role="img" aria-label={pointLabel} tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-app-accent">
            <title>{pointLabel}</title>
          </circle>
        );
      })}
      {first && <text x={span === 0 ? 174 : 38} y="106" textAnchor={span === 0 ? "middle" : "start"} fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(first.timestamp)}</text>}
      {span > 0 && last && <text x="310" y="106" textAnchor="end" fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(last.timestamp)}</text>}
    </svg>
  );
}

const PODIUM_COLORS = ["var(--app-podium-gold)", "var(--app-podium-silver)", "var(--app-podium-bronze)"] as const;
const PODIUM_STACK_ORDER = [2, 1, 0] as const;

function PodiumTrendChart({ trend }: { trend: DashboardInsights["podiums"]["trend"] }) {
  const first = trend[0];
  const last = trend[trend.length - 1];
  const width = Math.max(320, trend.length * 8 + 48);
  const step = (width - 48) / Math.max(trend.length, 1);
  const maxCount = Math.max(2, Math.ceil((last?.podiums ?? 0) / 2) * 2);
  const dates = new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" });
  const times = new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" });
  const labels = [m.home_insights_podiums_first(), m.home_insights_podiums_second(), m.home_insights_podiums_third()];
  return (
    <div className="mt-2 overflow-x-auto">
      <svg viewBox={`0 0 ${width} 112`} preserveAspectRatio="none" className="block h-28 w-full" style={{ minWidth: width > 320 ? width : undefined }} role="group" aria-label={m.home_insights_podiums_description()}>
        <title>{m.home_insights_podiums_description()}</title>
        {[0, maxCount / 2, maxCount].map((count) => (
          <text key={count} x="30" y={91 - count / maxCount * 76} textAnchor="end" fill="var(--app-text-muted)" className="font-mono text-app-caption">{count}</text>
        ))}
        {trend.map((point, index) => {
          const counts = [point.first, point.second, point.third] as const;
          const label = `${times.format(point.timestamp)} · ${m.home_insights_podiums_total({ total: point.podiums })} · ${counts.map((count, place) => `${labels[place]}: ${count}`).join(" · ")}`;
          const barWidth = Math.min(step * 0.8, 16);
          const x = 38 + index * step + (step - barWidth) / 2;
          let bottom = 88;
          return (
            <g key={point.sessionId} role="img" aria-label={label} tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-app-accent">
              <title>{label}</title>
              <rect x={x} y="12" width={barWidth} height="76" fill="var(--app-progress-track)" />
              {PODIUM_STACK_ORDER.map((place) => {
                const count = counts[place];
                const height = count / maxCount * 76;
                bottom -= height;
                return count > 0 ? <rect key={place} x={x} y={bottom} width={barWidth} height={height} fill={PODIUM_COLORS[place]} /> : null;
              })}
            </g>
          );
        })}
        {first && <text x="38" y="106" fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(first.timestamp)}</text>}
        {last && trend.length > 1 && <text x={width - 10} y="106" textAnchor="end" fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(last.timestamp)}</text>}
      </svg>
    </div>
  );
}

function ConsistencyChart({ insights, loading, error }: {
  insights: DashboardInsights;
  loading: boolean;
  error: boolean;
}) {
  const { sessions, averageStandardDeviation, deviations } = insights.consistency;
  const labels = HISTOGRAM_LABELS;
  const maxCount = Math.max(2, Math.ceil(Math.max(0, ...deviations) / 2) * 2);
  const status = loading ? m.home_insights_analytics_loading() : error ? m.home_insights_analytics_error() : null;

  return (
    <section aria-labelledby="insights-consistency-title" className={INSIGHT_PANEL_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-1">
          <h2 id="insights-consistency-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_consistency_title()}</h2>
          <InsightInfo label={m.home_insights_consistency_title()} content={m.home_insights_consistency_note()} />
        </div>
        {!status && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className={`whitespace-nowrap font-mono text-app-heading font-semibold tabular-nums ${averageStandardDeviation == null ? "text-app-text-muted" : "text-app-text"}`}>{averageStandardDeviation == null ? "—" : `±${averageStandardDeviation.toFixed(2)} s`}</p>
            {averageStandardDeviation != null && <p className="whitespace-nowrap text-app-caption tabular-nums text-app-text-muted">{m.home_insights_sample_count({ count: sessions })}</p>}
          </div>
        )}
      </div>
      {status ? (
        <p className={`mt-3 text-app-detail ${error ? "text-status-danger" : "text-app-text-muted"}`} role={error ? "alert" : "status"}>{status}</p>
      ) : averageStandardDeviation == null ? (
        <p className="mt-3 text-app-detail text-app-text-muted">{m.home_insights_consistency_insufficient()}</p>
      ) : (
        <svg viewBox="0 0 320 112" preserveAspectRatio="none" className="mt-3 block h-28 w-full" role="group" aria-label={m.home_insights_deviation_bins_label()}>
          <title>{m.home_insights_deviation_bins_label()}</title>
          {[0, maxCount / 2, maxCount].map((count) => (
            <text key={count} x="30" y={75 - count / maxCount * 60} textAnchor="end" fill="var(--app-text-muted)" className="font-mono text-app-caption">{count}</text>
          ))}
          {deviations.map((count, index) => {
            const interval = index === labels.length - 1 ? `≥${labels[index]} s` : `${labels[index]}–<${labels[index + 1]} s`;
            const x = 38 + index * 27.2;
            const height = count / maxCount * 60;
            return (
              <g key={labels[index]} role="img" aria-label={`${interval}: ${count}`} tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-app-accent">
                <title>{interval}: {count}</title>
                <rect x={x} y={72 - height} width="23.2" height={height} rx="2" fill={index === 0 ? "var(--app-accent)" : "var(--app-text-muted)"} />
                <text x={x + 11.6} y="90" textAnchor="middle" fill="var(--app-text-muted)" className="font-mono text-app-caption">{index === labels.length - 1 ? `≥${labels[index]}` : labels[index]}</text>
                <text x={x + 11.6} y="106" textAnchor="middle" fill="var(--app-text-secondary)" className="font-mono text-app-caption">{count}</text>
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}

 const now=Date.UTC(2026,9,1); const trend=[{timestamp:now,rate:0.5,total:4},{timestamp:now+86400000,rate:0.75,total:8}]; const podiums=[{sessionId:1,timestamp:now,podiums:1,first:1,second:0,third:0},{sessionId:2,timestamp:now+86400000,podiums:3,first:1,second:1,third:1}]; const insights={consistency:{sessions:3,averageStandardDeviation:0.25,deviations:[1,3,5,2,0,1,0,0,0,1]}}; createRoot(document.getElementById('root')).render(<main className="grid gap-3 p-4 md:grid-cols-3"><section className={INSIGHT_PANEL_CLASS}><h2>Clean laps</h2><PercentageTrendChart trend={trend} label="Clean laps"/></section><section className={INSIGHT_PANEL_CLASS}><h2>Podiums</h2><PodiumTrendChart trend={podiums}/></section><ConsistencyChart insights={insights} loading={false} error={false}/></main>);