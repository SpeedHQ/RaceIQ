/** Portless's page port differs from the dashboard listener forwarded by Vite. */
export function dashboardPort(serverPort: number): number {
  return import.meta.env.DEV
    ? Number(document.querySelector<HTMLMetaElement>('meta[name="raceiq-dashboard-port"]')?.content) || serverPort
    : serverPort;
}
