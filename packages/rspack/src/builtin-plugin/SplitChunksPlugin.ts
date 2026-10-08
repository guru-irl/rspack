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
  enableBatchCallbacks = false,
): RawSplitChunksOptions | undefined {
  if (!sc) {
    return;
  }

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
      if (!enableBatchCallbacks) {
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

  function getTest(test: OptimizationSplitChunksCacheGroup['test']) {
    if (typeof test === 'function') {
      const getInfo = () => ({
        moduleGraph: compiler._lastCompilation!.moduleGraph,
        chunkGraph: compiler._lastCompilation!.chunkGraph,
      });
      if (!enableBatchCallbacks) {
        return {
          test: (ctx: JsCacheGroupTestCtx) => test(ctx.module, getInfo()),
        };
      }
      return {
        testBatch: (modules: Module[]) => {
          const results = new Array<boolean | undefined>(modules.length);
          let thrown: number[] | undefined;
          let error: unknown;
          for (let i = 0; i < modules.length; i++) {
            try {
              results[i] = test(modules[i], getInfo());
            } catch (e) {
              if (thrown === undefined) {
                thrown = [];
                error = e;
              }
              thrown.push(i);
            }
          }
          return thrown === undefined ? results : { results, thrown, error };
        },
      };
    }
    return { test };
  }

  function getChunks(chunks: any) {
    if (typeof chunks === 'function') {
      return (chunk: Chunk) => chunks(chunk);
    }
    return chunks;
  }

  function getChunksOptions(chunks: OptimizationSplitChunksOptions['chunks']) {
    if (typeof chunks !== 'function' || !enableBatchCallbacks) {
      return { chunks: getChunks(chunks) };
    }
    return {
      chunksBatch: ({
        chunks: table,
        chunkIndices,
      }: {
        chunks: Chunk[];
        chunkIndices: Uint32Array;
      }) => {
        const results = new Array<boolean>(chunkIndices.length);
        let thrown: number[] | undefined;
        let error: unknown;
        for (let i = 0; i < chunkIndices.length; i++) {
          try {
            results[i] = chunks(table[chunkIndices[i]]);
          } catch (e) {
            if (thrown === undefined) {
              thrown = [];
              error = e;
            }
            thrown.push(i);
          }
        }
        return thrown === undefined ? results : { results, thrown, error };
      },
    };
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

  return {
    ...getName(name),
    ...getChunksOptions(chunks),
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
          ...getTest(test),
          ...getName(name),
          ...getChunksOptions(chunks),
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
}
