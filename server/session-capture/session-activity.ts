let activeSessionQuery: () => boolean = () => false;

export function registerActiveSessionQuery(query: () => boolean): void {
  activeSessionQuery = query;
}

export function isSessionActive(): boolean {
  return activeSessionQuery();
}
