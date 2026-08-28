import { useSelector } from "@tanstack/react-store";

export type StoreSource<T> = {
  get: () => T;
  subscribe: (listener: (value: T) => void) => { unsubscribe: () => void };
};
export type StoreDescriptor<T> = {
  name: string;
  store: StoreSource<T>;
};

export type StoreSnapshot = {
  name: string;
  state: unknown;
};

export function getTanStackStoreSnapshots(descriptors: readonly StoreDescriptor<unknown>[]): StoreSnapshot[] {
  return descriptors.map(({ name, store }) => ({ name, state: store.get() }));
}

type TanStackStoreDevtoolsPanelProps = {
  telemetry: StoreDescriptor<unknown>;
  game: StoreDescriptor<unknown>;
  ui: StoreDescriptor<unknown>;
  devTelemetry: StoreDescriptor<unknown>;
};

function StoreState({ descriptor }: { descriptor: StoreDescriptor<unknown> }) {
  const state = useSelector(descriptor.store, (value) => value);
  return (
    <details open className="border border-app-border rounded bg-app-surface">
      <summary className="cursor-pointer px-2 py-1 text-xs text-app-text">{descriptor.name}</summary>
      <pre className="overflow-auto border-t border-app-border p-2 text-xs font-mono text-app-text">{JSON.stringify(state, null, 2)}</pre>
    </details>
  );
}

export function TanStackStoreDevtoolsPanel({ telemetry, game, ui, devTelemetry }: TanStackStoreDevtoolsPanelProps) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-2">
      <span className="text-xs uppercase tracking-wider text-app-text-muted">TanStack Store</span>
      <StoreState descriptor={telemetry} />
      <StoreState descriptor={game} />
      <StoreState descriptor={ui} />
      <StoreState descriptor={devTelemetry} />
    </div>
  );
}
