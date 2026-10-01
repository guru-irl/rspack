---
description: '介绍 Rspack 中 Tracing 的使用方式'
---

# Tracing

[`tracing`](https://crates.io/crates/tracing) 用于记录 Rspack 内部的编译流程，既可用于性能分析，也可用于定位 Bug。

## 开启 Tracing

可以通过以下两种方式开启 tracing：

- 如果使用 [@rspack/cli](/api/cli) 或 Rsbuild：通过设置 `RSPACK_PROFILE` 环境变量来开启：

```sh
# Rspack CLI
RSPACK_PROFILE=OVERVIEW rspack build # 推荐
RSPACK_PROFILE=ALL rspack build # 不推荐，大项目可能会生成较大的 trace 文件

# Rsbuild
RSPACK_PROFILE=OVERVIEW rsbuild build
RSPACK_PROFILE=ALL rsbuild build
```

- 如果直接使用 `@rspack/core`：可通过 `rspack.experiments.globalTrace.register` 和 `rspack.experiments.globalTrace.cleanup` 开启。你可以查看我们如何在 [`@rspack/cli` 中实现 `RSPACK_PROFILE`](https://github.com/web-infra-dev/rspack/blob/main/packages/rspack-cli/src/utils/profile.ts) 获取更多信息。

启用 `perfetto` layer 后，生成的 `rspack.pftrace` 文件可以在 [ui.perfetto.dev](https://ui.perfetto.dev/) 中查看和分析：

<img
  src="https://assets.rspack.rs/rspack/assets/rspack-v1-4-tracing.png"
  alt="tracing"
/>

## Tracing layer

Rspack 支持 `perfetto` 和 `logger` 两种 layer：

- `logger`：默认值，将 JSON Lines 格式的日志写入文件，适用于简单的日志分析。在 CI 环境中，可以上传或打印生成的 `rspack.log`，也可以显式设置 `RSPACK_TRACE_OUTPUT=stdout` / `stderr` 将 logger 输出流式写到终端。
- `perfetto`：仅在使用 `@rspack-debug/core` 时可用，生成符合 [`perfetto proto`](https://perfetto.dev/docs/reference/synthetic-track-event) 格式的 `rspack.pftrace` 文件，可导入到 Perfetto 进行复杂的性能分析

`@rspack-debug/core` 是 `@rspack/core` 的诊断版本，包含额外的调试和 tracing 能力，例如 `perfetto` layer。当你需要为本地问题排查收集 Perfetto trace 时使用它，不建议把它作为常规构建的默认依赖。

可以通过 `RSPACK_TRACE_LAYER` 环境变量指定 layer：

```sh
RSPACK_TRACE_LAYER=logger

# 仅适用于 @rspack-debug/core
RSPACK_TRACE_LAYER=perfetto
```

## Tracing output

可以指定 trace 的输出位置：

- `logger` layer 的默认输出为 `.rspack-profile-${timestamp}-${pid}/rspack.log`
- `perfetto` layer 的默认输出为 `.rspack-profile-${timestamp}-${pid}/rspack.pftrace`

通过 `RSPACK_TRACE_OUTPUT` 环境变量可以自定义输出位置：

```sh
RSPACK_TRACE_LAYER=logger RSPACK_TRACE_OUTPUT=log.txt rspack dev

# 仅适用于 @rspack-debug/core
RSPACK_TRACE_LAYER=perfetto RSPACK_TRACE_OUTPUT=perfetto.pftrace rspack dev
```

当 `RSPACK_TRACE_OUTPUT` 是相对文件路径时，它会解析到生成的 `.rspack-profile-${timestamp}-${pid}` 目录下。绝对路径会按原样使用。对于 `logger` layer，如果需要输出到终端，可以显式设置为 `stdout` 或 `stderr`。`perfetto` layer 始终需要文件路径。

## Tracing filter

通过 `RSPACK_PROFILE` 可以配置需要过滤的数据。Rspack 提供了两个预设的 `preset`：

- `RSPACK_PROFILE=OVERVIEW`：默认值，只展示核心的构建流程，生成的 JSON 文件较小
- `RSPACK_PROFILE=ALL`：包含所有的 trace event，用于较为复杂的分析，生成的 JSON 文件较大

除了预设外，其他字符串都会透传给 [Env Filter](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html#example-syntax)，支持更复杂的过滤策略：

### Tracing level filter

支持的 tracing 等级有：`TRACE`、`DEBUG`、`INFO`、`WARN` 和 `ERROR`。可以通过等级进行过滤：

```sh
# trace level 是最高级别，输出所有日志
RSPACK_PROFILE=trace
# 只输出小于等于 INFO level 的日志
RSPACK_PROFILE=info
```

### 模块级别过滤

```sh
# 查看 rspack_resolver 的日志
RSPACK_TRACE_LAYER=logger RSPACK_PROFILE=rspack_resolver
```

### 混合过滤

EnvFilter 支持混合使用多种过滤条件，实现更复杂的过滤策略：

```sh
# 查看 rspack_core crate 里的 WARN level 的日志
RSPACK_PROFILE=rspack_core=warn
# 保留其他 crate 的 INFO level 日志但关闭 rspack_resolver 的日志
RSPACK_PROFILE=info,rspack_core=off
```

### 持久化缓存 {#persistent-cache}

对于旧版持久化缓存（`cache.type: 'persistent'` 且 `experiments.newCache: false`），可以在 INFO 等级下选择缓存和存储的 target：

```sh
RSPACK_PROFILE='off,rspack_core::legacy_cache::persistent=info,rspack_storage=info' \
RSPACK_TRACE_LAYER=logger rspack build
```

`off` 会关闭其他原生 target。持久化缓存 span 使用 `rspack_core::legacy_cache::persistent` 下的 Rust 模块路径作为 target，存储 span 的 target 则位于 `rspack_storage` 下。旧前缀 `rspack_core::cache` 已无法匹配这些持久化缓存 span。

target 与 span 名称不同。例如，`Cache::Occasion::SourceMap::serialize` 是 span 名称，其 target 为 `rspack_core::legacy_cache::persistent::occasion::devtool`。模块图、source map 和压缩的 occasion 会分别在编码或解码阶段记录一个 `serialize` 或 `deserialize` span，而不是为每个缓存条目记录一个 span。如果同一循环中还包含准备、暂存或重建操作，这些操作也会计入对应阶段。[`stats.loggingDebug`](/config/cache#inspect-persistent-cache-logs) 使用的 `rspack.persistentCache` 是独立的 stats logger 名称，不是原生 trace target。

release binding 可以通过 `logger` layer 记录这些 INFO span。DEBUG 和 TRACE span 会在 release binding 中被编译移除，设置 `ALL` 或更详细的过滤条件也无法恢复它们。Perfetto 需要 debug binding，配置方式请参考[使用 `@rspack-debug/core`](/contribute/development/debugging)。

分析存储耗时时，需要注意：

- `Storage::FileSystem::save` 和 `Cache::Context::save_storage` 是同步操作，只记录将后台写入加入队列的耗时，不包含实际写入。
- 队列中的写入会记录为 `Storage::DB::save`、`Storage::Pack::save` 和 `Storage::Pack::flush`。最后的 `Storage::FileSystem::flush` 会在编译器关闭时等待队列中的任务完成。
- `Storage::Pack::flush` 记录的是 writer flush，不是 `fsync`，也不代表数据已持久化到磁盘。

直接使用 `@rspack/core` 时，应在创建编译器前注册 tracing，并等待 `compiler.close(callback)` 完成后再调用 `rspack.experiments.globalTrace.cleanup()`，确保后台缓存写入先于 trace 清理完成。JavaScript 记录（`target: "javascript"`）不受原生过滤条件影响，因此仍可能出现在这次采集中。
