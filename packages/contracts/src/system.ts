/** A finite vocabulary for module responsibilities and their presentation. */
export enum FeatureType {
  Policy = 'policy',
  Store = 'store',
  Feature = 'feature',
  Service = 'service',
  View = 'view',
}

export type ModuleState =
  | 'loading'
  | 'starting'
  | 'ready'
  | 'cancelling'
  | 'rolling-back'
  | 'disposing'
  | 'disposed'
  | 'cancelled'
  | 'failed';

export type SystemState = 'running' | 'disposing' | 'disposed' | 'failed';

export interface FeaturePortSnapshot {
  readonly name: string;
  readonly description: string;
}

export interface FeatureContractSnapshot {
  readonly inputs: readonly FeaturePortSnapshot[];
  readonly exports: readonly FeaturePortSnapshot[];
}

/** Descriptions and lifecycle only: no application input or export values. */
export interface ModuleSnapshot {
  readonly id: string;
  readonly definitionId: string;
  readonly kind: FeatureType;
  readonly title: string;
  readonly description: string;
  readonly contract: FeatureContractSnapshot;
  readonly dependencies: readonly string[];
  readonly state: ModuleState;
  readonly error?: string;
}

export type SystemEventType = ModuleState | SystemState
  | 'operation-started'
  | 'operation-completed'
  | 'operation-failed';

export interface SystemEvent {
  /** Monotonically increasing across the entire system, even after eviction. */
  readonly sequence: number;
  /** Milliseconds since the Unix epoch. */
  readonly timestamp: number;
  readonly moduleId?: string;
  readonly type: SystemEventType;
  readonly operation?: string;
  readonly error?: string;
}

/** An immutable, framework-neutral view suitable for a renderer or recorder. */
export interface SystemSnapshot {
  readonly id: string;
  readonly state: SystemState;
  readonly modules: readonly ModuleSnapshot[];
  readonly events: readonly SystemEvent[];
  readonly droppedEvents: number;
}
