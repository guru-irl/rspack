import fs from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  type BuiltinPlugin,
  BuiltinPluginName,
  type JsCacheGroupTestCtx,
  type RawCacheGroupOptions,
  type RawSplitChunksOptions,
} from '@rspack/binding';

import type { Chunk } from '../Chunk';
import type { Compiler } from '../Compiler';
import type {
  OptimizationSplitChunksCacheGroup,
  OptimizationSplitChunksOptions,
} from '../config';
import type { Module } from '../Module';
import { JsSplitChunkSizes } from '../util/SplitChunkSize';
import { createBuiltinPlugin, RspackBuiltinPlugin } from './base';

type SelectorKind = 'test' | 'chunks' | 'name';
type CallCounts = Record<SelectorKind, { dispatches: number; items: number }>;
interface CallStats {
  counts: CallCounts;
}

let compilerCallStats: WeakMap<Compiler, CallStats> | undefined;
let nextCompilerLabel = 0;

function getCallStats(compiler: Compiler): CallStats | undefined {
  const file = process.env.RSPACK_SPLIT_CHUNKS_CALL_STATS;
  if (!file) {
    return;
  }
  if (!isAbsolute(file)) {
    throw new Error(
      'RSPACK_SPLIT_CHUNKS_CALL_STATS must be an absolute file path',
    );
  }
  compilerCallStats ??= new WeakMap();
  const existing = compilerCallStats.get(compiler);
  if (existing) {
    return existing;
  }
  const stats: CallStats = {
    counts: {
      test: { dispatches: 0, items: 0 },
      chunks: { dispatches: 0, items: 0 },
      name: { dispatches: 0, items: 0 },
    },
  };
  compilerCallStats.set(compiler, stats);
  const label = compiler.name ?? `compiler-${nextCompilerLabel++}`;
  let phaseIndex = 0;
  compiler.hooks.done.tap('SplitChunksCallStats', () => {
    fs.appendFileSync(
      file,
      `${JSON.stringify({ compiler: label, phaseIndex, counts: stats.counts })}\n`,
    );
    phaseIndex++;
    for (const kind of ['test', 'chunks', 'name'] as const) {
      stats.counts[kind].dispatches = 0;
      stats.counts[kind].items = 0;
    }
  });
  return stats;
}

function countItems<T extends (...args: any[]) => any>(
  fn: T,
  stats: CallStats,
  kind: SelectorKind,
): T {
  return ((...args: Parameters<T>) => {
    stats.counts[kind].items++;
    return fn(...args);
  }) as T;
}

function countDispatches<T extends (...args: any[]) => any>(
  fn: T,
  stats: CallStats,
  kind: SelectorKind,
): T {
  return ((...args: Parameters<T>) => {
    stats.counts[kind].dispatches++;
    return fn(...args);
  }) as T;
}

function instrumentDispatches(
  options: RawSplitChunksOptions,
  stats: CallStats,
): RawSplitChunksOptions {
  const instrument = (target: object) => {
    const callbacks = target as Record<string, unknown>;
    for (const kind of ['test', 'chunks', 'name'] as const) {
      for (const key of [kind, `${kind}Batch`]) {
        const fn = callbacks[key];
        if (typeof fn === 'function') {
          callbacks[key] = countDispatches(
            fn as (...args: any[]) => any,
            stats,
            kind,
          );
        }
      }
    }
  };
  instrument(options);
  for (const group of options.cacheGroups ?? []) {
    instrument(group);
  }
  // Preserve the existing fallback option normalization and precedence.
  // Only callbacks created by getChunks are instrumented here.
  return options;
}

export class SplitChunksPlugin extends RspackBuiltinPlugin {
  name = BuiltinPluginName.SplitChunksPlugin;
  affectedHooks = 'thisCompilation' as const;

  constructor(private options: OptimizationSplitChunksOptions) {
    super();
  }

  raw(compiler: Compiler): BuiltinPlugin {
    const rawOptions = toRawSplitChunksOptions(this.options, compiler, true);
    if (rawOptions === undefined) {
      throw new Error('rawOptions should not be undefined');
    }
    return createBuiltinPlugin(this.name, rawOptions);
  }
}

export function toRawSplitChunksOptions(
  sc: false | OptimizationSplitChunksOptions,
  compiler: Compiler,
  enableNameBatch = false,
): RawSplitChunksOptions | undefined {
  if (!sc) {
    return;
  }

  const stats = getCallStats(compiler);

  const { dedupDepth } = sc;
  if (
    dedupDepth !== undefined &&
    (!Number.isInteger(dedupDepth) || dedupDepth < 0 || dedupDepth > 0xffffffff)
  ) {
    throw new Error(
      `Invalid Rspack configuration: "optimization.splitChunks.dedupDepth" must be an integer between 0 and 4294967295, get \`${dedupDepth}\`.`,
    );
  }

  function getName(name: any) {
    interface Context {
      module: Module;
      chunks: Chunk[];
      cacheGroupKey: string;
    }

    if (typeof name === 'function') {
      if (stats) {
        name = countItems(name, stats, 'name');
      }
      if (!enableNameBatch) {
        return {
          name: (ctx: Context) => {
            if (typeof ctx.module === 'undefined') {
              return name(undefined);
            }
            return name(ctx.module, getChunks(ctx.chunks), ctx.cacheGroupKey);
          },
        };
      }

      return {
        nameBatch: getNameBatch(name),
      };
    }
    return { name };
  }

  function getNameBatch(name: any) {
    interface Batch {
      modules: Module[];
      chunks: Chunk[];
      chunkData: Uint32Array;
      cacheGroupKey: string;
    }

    return (batch: Batch) => {
      const { modules, chunks, chunkData, cacheGroupKey } = batch;
      const results = new Array(modules.length);
      // The offset table is followed by indices into the deduplicated chunk array.
      const chunkIndexStart = modules.length + 1;

      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const start = chunkData[i];
        const end = chunkData[i + 1];
        const contextChunks = new Array<Chunk>(end - start);
        for (let j = start; j < end; j++) {
          contextChunks[j - start] = chunks[chunkData[chunkIndexStart + j]];
        }

        if (typeof module === 'undefined') {
          results[i] = name(undefined);
        } else {
          results[i] = name(module, contextChunks, cacheGroupKey);
        }
      }

      return results;
    };
  }

  function getTest(testOption: OptimizationSplitChunksCacheGroup['test']) {
    if (typeof testOption === 'function') {
      const test = stats ? countItems(testOption, stats, 'test') : testOption;
      return (ctx: JsCacheGroupTestCtx) => {
        // chunk graph and module graph should all exist in the optimizeChunks stage
        const info = {
          moduleGraph: compiler._lastCompilation!.moduleGraph,
          chunkGraph: compiler._lastCompilation!.chunkGraph,
        };
        return test(ctx.module, info);
      };
    }
    return testOption;
  }

  function getChunks(chunks: any) {
    if (typeof chunks === 'function') {
      if (stats) {
        chunks = countItems(chunks, stats, 'chunks');
      }
      return (chunk: Chunk) => chunks(chunk);
    }
    return chunks;
  }

  const {
    name,
    chunks,
    defaultSizeTypes,
    cacheGroups = {},
    fallbackCacheGroup,
    minSize,
    minSizeReduction,
    enforceSizeThreshold,
    maxSize,
    maxAsyncSize,
    maxInitialSize,
    ...passThrough
  } = sc;

  const options: RawSplitChunksOptions = {
    ...getName(name),
    chunks: getChunks(chunks),
    defaultSizeTypes: defaultSizeTypes || ['javascript', 'unknown'],
    cacheGroups: Object.entries(cacheGroups)
      .filter(([_key, group]) => group !== false)
      .map(([key, group]) => {
        const {
          test,
          name,
          chunks,
          minSize,
          minSizeReduction,
          enforceSizeThreshold,
          maxSize,
          maxAsyncSize,
          maxInitialSize,
          ...passThrough
        } = group as Exclude<typeof group, false>;
        const rawGroup: RawCacheGroupOptions = {
          key,
          test: getTest(test),
          ...getName(name),
          chunks: getChunks(chunks),
          minSize: JsSplitChunkSizes.__to_binding(minSize),
          minSizeReduction: JsSplitChunkSizes.__to_binding(minSizeReduction),
          enforceSizeThreshold:
            JsSplitChunkSizes.__to_binding(enforceSizeThreshold),
          maxSize: JsSplitChunkSizes.__to_binding(maxSize),
          maxAsyncSize: JsSplitChunkSizes.__to_binding(maxAsyncSize),
          maxInitialSize: JsSplitChunkSizes.__to_binding(maxInitialSize),
          ...passThrough,
        };
        return rawGroup;
      }),
    fallbackCacheGroup: {
      chunks: getChunks(chunks),
      ...fallbackCacheGroup,
    },
    minSize: JsSplitChunkSizes.__to_binding(minSize),
    minSizeReduction: JsSplitChunkSizes.__to_binding(minSizeReduction),
    enforceSizeThreshold: JsSplitChunkSizes.__to_binding(enforceSizeThreshold),
    maxSize: JsSplitChunkSizes.__to_binding(maxSize),
    maxAsyncSize: JsSplitChunkSizes.__to_binding(maxAsyncSize),
    maxInitialSize: JsSplitChunkSizes.__to_binding(maxInitialSize),
    ...passThrough,
    dedupDepth:
      dedupDepth ??
      (compiler.options.mode === 'development' ||
      compiler.options.mode === 'none'
        ? 0
        : 1),
  };
  if (stats) {
    const fallback = options.fallbackCacheGroup;
    if (
      fallback &&
      typeof chunks === 'function' &&
      !Object.prototype.hasOwnProperty.call(fallbackCacheGroup ?? {}, 'chunks')
    ) {
      const callbacks = fallback as Record<string, unknown>;
      callbacks.chunks = countDispatches(
        callbacks.chunks as (chunk: Chunk) => boolean,
        stats,
        'chunks',
      );
    }
    return instrumentDispatches(options, stats);
  }
  return options;
}
