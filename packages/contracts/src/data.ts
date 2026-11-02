/** Public data contracts and their wiring, never application records. */
export interface DataPortSnapshot {
  readonly definitionId: string;
  readonly port: string;
  readonly capabilities: readonly string[];
}

export interface DataNodeSnapshot {
  readonly id: string;
  readonly version: number;
  readonly provider: DataPortSnapshot;
  readonly consumers: readonly DataPortSnapshot[];
  readonly relations: readonly string[];
}
