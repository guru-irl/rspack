use rspack_error::Result;

use crate::{Compilation, SharedPluginDriver, incremental::IncrementalPasses, logger::Logger};

pub async fn finish_make_pass(
  compilation: &mut Compilation,
  plugin_driver: SharedPluginDriver,
) -> Result<()> {
  let logger = compilation.get_logger("rspack.Compiler");
  let start = logger.time("finish make hook");
  plugin_driver
    .compiler_hooks
    .finish_make
    .call(compilation)
    .await?;
  logger.time_end(start);

  if compilation
    .incremental
    .passes_enabled(IncrementalPasses::BUILD_MODULE_GRAPH)
    && let Some(cache) = &compilation.resolver_cache
  {
    compilation.resolver_cache_release = Some(
      crate::new_cache::resolver_cache::ResolverCacheRelease::start(
        cache.clone(),
        compilation.resolver_factory.clone(),
        compilation.loader_resolver_factory.clone(),
      ),
    );
  }

  Ok(())
}
