/** Stop a subscription. Calling it again has no effect. */
export type Unsubscribe = () => void;

/** True when a change is irrelevant to a consumer. */
export type Equality<T> = (previous: T, next: T) => boolean;

/**
 * A synchronous read boundary without mutation or renderer dependencies.
 * Subscribe reports subsequent changes; read supplies the initial value.
 */
export interface Readable<T> {
  readonly read: () => T;
  readonly subscribe: (listener: (value: T) => void) => Unsubscribe;
}
