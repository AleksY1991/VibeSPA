import type { Equality } from '@vibespa/contracts';
import type { ReactivityLambda, RxReactivityFactory } from 'rxdb';
import type { Observable } from 'rxjs';
import { createSignal, getOwner, onCleanup, untrack, type Accessor } from 'solid-js';
import { forgetRxPublication, publishRxValue } from './rxdbBatch.js';

export {
  beginRxBatch, forgetRxPublication, isRxBatchActive, publishRxValue, waitForRxBatches,
} from './rxdbBatch.js';

/** RxDB's native `$$` and `get$$` getters return Solid accessors. */
export interface SolidRxReactivityLambda extends ReactivityLambda {
  readonly _result: Accessor<this['_data']>;
}

export interface SolidRxReactivityOptions {
  readonly name?: string;
  /** Defaults to false so every native RxDB emission reaches its consumer. */
  readonly equals?: false | Equality<unknown>;
}

/** Configure RxDB's renderer adapter without copying documents into another store. */
export function createSolidRxReactivityFactory(
  options: SolidRxReactivityOptions = {},
): RxReactivityFactory<SolidRxReactivityLambda> {
  const name = options.name ?? 'vibespa.rxdb';
  const equals = options.equals ?? false;
  return {
    fromObservable<Data, InitData>(
      observable: Observable<Data>, initialValue: InitData, database: object,
    ): Accessor<Data | InitData> {
      if (!getOwner()) {
        throw new Error('RxDB $$ bindings must be created inside a Solid owner');
      }
      // The thunk preserves callable data and permits a synchronous first emission.
      const [value, setValue] = createSignal<Data | InitData>(() => initialValue, {
        name, equals, ownedWrite: true,
      });
      const binding = {};
      let active = true;
      const subscription = observable.subscribe(next => {
        if (active) publishRxValue(database, binding, () => {
          if (active) untrack(() => setValue(() => next));
        });
      });
      onCleanup(() => {
        active = false;
        forgetRxPublication(database, binding);
        subscription.unsubscribe();
      });
      return value;
    },
  };
}

/** Default shared adapter used by products that need no custom equality. */
export const SolidRxReactivityFactory = createSolidRxReactivityFactory();

/** Structural inputs let integrations retain RxDB's exact accessor types. */
export interface SolidRxBinding<T> {
  readonly $$: Accessor<T>;
}

/** Read the getter once under its Solid owner and retain the returned accessor. */
export function bindRxValue<Source extends SolidRxBinding<unknown>>(source: Source): Source['$$'] {
  return source.$$;
}

/** Preserve the source's null, undefined, and loading sentinel types verbatim. */
export function bindRxDocument<T>(query: SolidRxBinding<T>): Accessor<T> {
  return query.$$;
}

export interface SolidRxFieldBinding {
  get$$(path: string): Accessor<unknown>;
}

/** Read one native document field without converting its value. */
export function bindRxField<T>(document: SolidRxFieldBinding, path: string): Accessor<T> {
  return document.get$$(path) as Accessor<T>;
}

/** Seed ID bindings from RxDB's own revision cache without another entity store. */
export function cachedRxDocuments<Data extends { readonly _deleted: boolean }, Document>(
  cache: {
    getLatestDocumentDataIfExists(id: string): Data | undefined;
    getCachedRxDocument(data: Data): Document;
  },
  id: string,
): readonly Document[] | undefined {
  const data = cache.getLatestDocumentDataIfExists(id);
  return data ? data._deleted ? [] : [cache.getCachedRxDocument(data)] : undefined;
}
