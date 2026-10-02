export interface TelemetryVersionIdentity {
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly catalogSchemaVersion: string;
  readonly parserVersion: string;
  readonly resolverVersion: string;
  readonly derivationVersion: string;
}
