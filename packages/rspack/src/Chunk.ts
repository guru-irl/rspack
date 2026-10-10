import util from 'node:util';
import { Chunk, ChunkGroup, type JsCompilation } from '@rspack/binding';
import type * as liteTapable from '@rspack/lite-tapable';

const COLLECTION_BUDGET = 2.5 * 1024 * 1024;
interface CollectionSnapshot<T> {
  stamp: number;
  values: T[];
}
let scopeDepth = 0;
let scopeCompilation: JsCompilation | undefined;
let remainingBytes = 0;
let snapshots:
  | [
      WeakMap<object, CollectionSnapshot<unknown>>,
      WeakMap<object, CollectionSnapshot<unknown>>,
      WeakMap<object, CollectionSnapshot<unknown>>,
    ]
  | undefined;

/** Only the synchronous prefix is scoped, including nested async callbacks. */
function scopedTap<T extends unknown[], R>(
  fn: (...args: T) => R,
  compilation: JsCompilation,
): (...args: T) => R {
  return function (this: unknown, ...args: T): R {
    if (scopeDepth++ === 0) {
      remainingBytes = COLLECTION_BUDGET;
      snapshots = [new WeakMap(), new WeakMap(), new WeakMap()];
    }
    const previousCompilation = scopeCompilation;
    scopeCompilation = compilation;
    try {
      return fn.apply(this, args);
    } finally {
      scopeCompilation = previousCompilation;
      if (--scopeDepth === 0) {
        snapshots = undefined;
        remainingBytes = 0;
      }
    }
  };
}

export function scopeChunkCollectionReads<T>(
  hook: liteTapable.AsyncSeriesHook<T>,
  compilation: JsCompilation,
): void {
  const tap = hook.tap;
  const tapAsync = hook.tapAsync;
  const tapPromise = hook.tapPromise;
  hook.tap = function (options, fn) {
    return tap.call(this, options, scopedTap(fn, compilation));
  };
  hook.tapAsync = function (options, fn) {
    return tapAsync.call(this, options, scopedTap(fn, compilation));
  };
  hook.tapPromise = function (options, fn) {
    return tapPromise.call(this, options, scopedTap(fn, compilation));
  };
}

function collectionGetter<T, O extends Chunk | ChunkGroup>(
  kind: 0 | 1 | 2,
  original: (this: O) => T[],
  set: boolean,
) {
  return function (this: O) {
    const copy = (values: T[]) => (set ? new Set(values) : values.slice());
    if (
      !snapshots ||
      !scopeCompilation ||
      typeof this._collectionStamp !== 'function'
    ) {
      return copy(original.call(this));
    }
    const map = snapshots[kind];
    const cached = map.get(this);
    if (!cached && remainingBytes < 160) return copy(original.call(this));
    let stamp: number | undefined;
    try {
      stamp = this._collectionStamp(kind, scopeCompilation);
    } catch {
      return copy(original.call(this));
    }
    if (stamp === undefined) return copy(original.call(this));
    if (cached?.stamp === stamp) return copy(cached.values as T[]);
    const values = original.call(this);
    let charge = 160 + 8 * values.length;
    if (kind === 0) {
      charge += 32 * values.length;
      for (const value of values) charge += 2 * (value as string).length;
    }
    if (charge <= remainingBytes) {
      try {
        if (this._collectionStamp(kind, scopeCompilation) === stamp) {
          map.set(this, { stamp, values });
          remainingBytes -= charge;
        }
      } catch {
        /* Original materialization already succeeded. Do not admit. */
      }
    }
    return copy(values);
  };
}

Object.defineProperty(Chunk.prototype, 'files', {
  enumerable: true,
  configurable: true,
  get: collectionGetter(
    0,
    function (this: Chunk) {
      return this._files;
    },
    true,
  ),
});
Object.defineProperty(Chunk.prototype, 'runtime', {
  enumerable: true,
  configurable: true,
  get(this: Chunk) {
    return new Set(this._runtime);
  },
});
Object.defineProperty(Chunk.prototype, 'auxiliaryFiles', {
  enumerable: true,
  configurable: true,
  get(this: Chunk) {
    return new Set(this._auxiliaryFiles);
  },
});
Object.defineProperty(Chunk.prototype, 'groupsIterable', {
  enumerable: true,
  configurable: true,
  get: collectionGetter(
    1,
    function (this: Chunk) {
      return this._groupsIterable;
    },
    true,
  ),
});
const chunksDescriptor = Object.getOwnPropertyDescriptor(
  ChunkGroup.prototype,
  'chunks',
)!;
Object.defineProperty(ChunkGroup.prototype, 'chunks', {
  ...chunksDescriptor,
  get: collectionGetter(
    2,
    chunksDescriptor.get! as (this: ChunkGroup) => Chunk[],
    false,
  ),
});

interface ChunkMaps {
  hash: Record<string | number, string>;
  contentHash: Record<string | number, Record<string, string>>;
  name: Record<string | number, string>;
}

Object.defineProperty(Chunk.prototype, 'getChunkMaps', {
  enumerable: true,
  configurable: true,
  value(this: Chunk, realHash: boolean): ChunkMaps {
    const chunkHashMap: Record<string | number, string> = {};
    const chunkContentHashMap: Record<
      string | number,
      Record<string, string>
    > = {};
    const chunkNameMap: Record<string | number, string> = {};

    for (const chunk of this.getAllAsyncChunks()) {
      const id = chunk.id;
      if (id === undefined) continue;
      const chunkHash = realHash ? chunk.hash : chunk.renderedHash;
      if (chunkHash) {
        chunkHashMap[id] = chunkHash;
      }
      for (const key of Object.keys(chunk.contentHash)) {
        if (!chunkContentHashMap[key]) {
          chunkContentHashMap[key] = {};
        }
        chunkContentHashMap[key][id] = chunk.contentHash[key];
      }
      if (chunk.name) {
        chunkNameMap[id] = chunk.name;
      }
    }

    return {
      hash: chunkHashMap,
      contentHash: chunkContentHashMap,
      name: chunkNameMap,
    };
  },
});

Object.defineProperty(Chunk.prototype, util.inspect.custom, {
  enumerable: true,
  configurable: true,
  value(this: Chunk): any {
    return { ...this };
  },
});

declare module '@rspack/binding' {
  interface Chunk {
    readonly files: ReadonlySet<string>;
    readonly runtime: ReadonlySet<string>;
    readonly auxiliaryFiles: ReadonlySet<string>;
    readonly groupsIterable: ReadonlySet<ChunkGroup>;
    getChunkMaps(realHash: boolean): ChunkMaps;
  }
}

export { Chunk } from '@rspack/binding';
