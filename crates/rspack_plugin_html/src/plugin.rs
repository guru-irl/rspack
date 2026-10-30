use std::{
  borrow::Cow,
  path::{Path, PathBuf},
  sync::{Arc, LazyLock},
};

use atomic_refcell::AtomicRefCell;
use cow_utils::CowUtils;
use rspack_core::{
  Compilation, CompilationFullHash, CompilationId, CompilationProcessAssets, Filename, Plugin,
};
use rspack_error::{Diagnostic, Result};
use rspack_hash::RspackHasher;
use rspack_hook::{plugin, plugin_hook};
use rspack_util::fx_hash::FxDashMap;
#[cfg(allocative)]
use rspack_util::rspack_allocative;
use sugar_path::SugarPath;

use crate::{
  AfterEmitData, AfterTemplateExecutionData, AlterAssetTagGroupsData, AlterAssetTagsData,
  BeforeAssetTagGenerationData, BeforeEmitData, HtmlPluginHooks,
  asset::{HtmlPluginAssetTags, HtmlPluginAssets, create_favicon_asset, create_html_asset},
  config::{HtmlInject, HtmlRspackPluginOptions, TemplateParameters},
  injector::AssetInjector,
  parser::HtmlCompiler,
  template::{HtmlTemplate, TemplateRender},
};

/// Safety with [atomic_refcell::AtomicRefCell]:
///
/// We should make sure that there's no read-write and write-write conflicts for each hook instance by looking up [HtmlRspackPlugin::get_compilation_hooks_mut]
type ArcHtmlPluginHooks = Arc<AtomicRefCell<HtmlPluginHooks>>;

#[cfg_attr(allocative, rspack_allocative::root)]
static COMPILATION_HOOKS_MAP: LazyLock<FxDashMap<CompilationId, ArcHtmlPluginHooks>> =
  LazyLock::new(Default::default);

#[plugin]
#[derive(Debug)]
pub struct HtmlRspackPlugin {
  config: HtmlRspackPluginOptions,
}

impl HtmlRspackPlugin {
  pub fn new(config: HtmlRspackPluginOptions) -> Self {
    Self::new_inner(config)
  }

  pub fn get_compilation_hooks(id: CompilationId) -> Arc<AtomicRefCell<HtmlPluginHooks>> {
    if !COMPILATION_HOOKS_MAP.contains_key(&id) {
      COMPILATION_HOOKS_MAP.insert(id, Default::default());
    }
    COMPILATION_HOOKS_MAP
      .get(&id)
      .expect("should have js plugin drive")
      .clone()
  }

  pub fn get_compilation_hooks_mut(id: CompilationId) -> ArcHtmlPluginHooks {
    COMPILATION_HOOKS_MAP.entry(id).or_default().clone()
  }
}

async fn generate_html(
  filename: &str,
  html_file_name: &Filename,
  config: &HtmlRspackPluginOptions,
  compilation: &mut Compilation,
  hooks: ArcHtmlPluginHooks,
) -> Result<(String, String, Vec<PathBuf>)> {
  let public_path = config.get_public_path(compilation, filename).await;

  let mut template = HtmlTemplate::new(config, compilation).await?;

  let template_file_name = compilation
    .options
    .output
    .path
    .join(template.filename.clone());

  let assets_info = HtmlPluginAssets::create_assets(
    config,
    compilation,
    &public_path,
    &template_file_name,
    html_file_name,
  )
  .await?;

  let before_generation_data = hooks
    .borrow()
    .before_asset_tag_generation
    .call(BeforeAssetTagGenerationData {
      assets: assets_info.0,
      output_name: html_file_name.as_str().to_string(),
      compilation_id: compilation.id(),
      uid: config.uid,
    })
    .await?;

  let asset_tags: HtmlPluginAssetTags =
    HtmlPluginAssetTags::from_assets(config, &before_generation_data.assets);

  let alter_asset_tags_data = hooks
    .borrow()
    .alter_asset_tags
    .call(AlterAssetTagsData {
      asset_tags,
      public_path: public_path.clone(),
      output_name: html_file_name.as_str().to_string(),
      compilation_id: compilation.id(),
      uid: config.uid,
    })
    .await?;

  let (head_tags, body_tags) =
    HtmlPluginAssetTags::to_groups(config, alter_asset_tags_data.asset_tags);

  let alter_asset_tag_groups_data = hooks
    .borrow()
    .alter_asset_tag_groups
    .call(AlterAssetTagGroupsData {
      head_tags,
      body_tags,
      public_path: public_path.clone(),
      output_name: html_file_name.as_str().to_string(),
      compilation_id: compilation.id(),
      uid: config.uid,
    })
    .await?;

  template
    .create_parameters(
      filename,
      config,
      &alter_asset_tag_groups_data.head_tags,
      &alter_asset_tag_groups_data.body_tags,
      &before_generation_data.assets,
      compilation,
    )
    .await?;

  let template_execution_result = template.render(config).await?;

  let after_template_execution_data = hooks
    .borrow()
    .after_template_execution
    .call(AfterTemplateExecutionData {
      html: template_execution_result,
      head_tags: alter_asset_tag_groups_data.head_tags,
      body_tags: alter_asset_tag_groups_data.body_tags,
      output_name: html_file_name.as_str().to_string(),
      compilation_id: compilation.id(),
      uid: config.uid,
    })
    .await?;

  let parser = HtmlCompiler::new(config);

  let ast_with_diagnostic = parser.parse_file(&template.url, after_template_execution_data.html)?;

  let (mut current_ast, diagnostic) = ast_with_diagnostic.split_into_parts();

  if !diagnostic.is_empty() {
    compilation.extend_diagnostics(diagnostic);
  }

  if !matches!(config.inject, HtmlInject::False) {
    let mut visitor = AssetInjector::new(
      &after_template_execution_data.head_tags,
      &after_template_execution_data.body_tags,
    );
    current_ast.visit_mut_with(&mut visitor);
  }

  let raw_html = parser.codegen(&mut current_ast, compilation)?;
  let html = raw_html.cow_replace("$$RSPACK_URL_AMP$$", "&");

  Ok((
    template_file_name.to_string(),
    html.into_owned(),
    template.file_dependencies,
  ))
}

#[plugin_hook(CompilationFullHash for HtmlRspackPlugin)]
async fn full_hash(&self, compilation: &Compilation, hasher: &mut RspackHasher) -> Result<()> {
  let mut config = serde_json::to_value(&self.config).expect("HTML options should serialize");
  let options = config
    .as_object_mut()
    .expect("HTML options should be an object");
  // The uid identifies a JavaScript plugin instance, not its output.
  options.remove("uid");
  for key in ["template", "favicon"] {
    if let Some(path) = options[key].as_str() {
      let path = compilation.options.context.as_path().join(path);
      let relative = self.config.get_relative_path(compilation, path.as_str());
      options[key] = relative.replace('\\', "/").into();
    }
  }
  let output = compilation.options.output.path.as_std_path();
  if let Some(filenames) = options["filename"].as_array_mut() {
    for filename in filenames {
      if let Some(path) = filename.as_str() {
        *filename = output
          .join(path)
          .relative(output)
          .to_string_lossy()
          .replace('\\', "/")
          .into();
      }
    }
  }
  match &self.config.template_parameters {
    TemplateParameters::Map(parameters) => {
      options.insert(
        "templateParameters".into(),
        serde_json::to_value(parameters).expect("template parameters should serialize"),
      );
    }
    TemplateParameters::Disabled => {
      options.insert("templateParameters".into(), serde_json::Value::Bool(false));
    }
    TemplateParameters::Function(_) => {}
  }
  config.sort_all_objects();
  hasher.update(&config.to_string());

  // process_assets reports template read errors and emits the error page.
  // Function-valued options and HTML hooks run later and cannot be hashed here.
  if let Ok(template) = HtmlTemplate::new(&self.config, compilation).await
    && let TemplateRender::Template(content) = template.render
  {
    hasher.update(&content);
  }
  Ok(())
}

#[plugin_hook(CompilationProcessAssets for HtmlRspackPlugin, stage = Compilation::PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE)]
async fn process_assets(&self, compilation: &mut Compilation) -> Result<()> {
  let config: &HtmlRspackPluginOptions = &self.config;
  let hooks = HtmlRspackPlugin::get_compilation_hooks(compilation.id());

  // TODO: parallel generate html
  for filename in &config.filename {
    let filename = filename.cow_replace("[templatehash]", "[contenthash]");

    // convert absolute filename into relative so that webpack can
    // generate it at correct location
    let filename = {
      let filename_path = Path::new(filename.as_ref());
      if filename_path.is_absolute() {
        let output_path = &compilation.options.output.path;
        Cow::from(
          filename_path
            .relative(output_path)
            .to_string_lossy()
            .to_string(),
        )
      } else {
        filename
      }
    };

    let output_file_name = Filename::from(filename.to_string());

    let (template_file_name, html) = match generate_html(
      filename.as_ref(),
      &output_file_name,
      config,
      compilation,
      hooks.clone(),
    )
    .await
    {
      Ok(content) => {
        compilation
          .file_dependencies
          .extend(content.2.into_iter().map(Into::into));
        (content.0, content.1)
      }
      Err(err) => {
        let error_msg = err.to_string();
        compilation.push_diagnostic(Diagnostic::from(err));
        ("error.html".to_string(), create_error_html(&error_msg))
      }
    };

    let mut before_emit_data = hooks
      .borrow()
      .before_emit
      .call(BeforeEmitData {
        html,
        output_name: output_file_name.as_str().to_string(),
        compilation_id: compilation.id(),
        uid: config.uid,
      })
      .await?;

    if let Some(favicon) = &config.favicon {
      match create_favicon_asset(favicon, config, compilation).await {
        Ok(favicon) => compilation.emit_asset(favicon.0, favicon.1),
        Err(err) => {
          let error_msg = err.to_string();
          compilation.push_diagnostic(Diagnostic::from(err));
          before_emit_data.html = create_error_html(&error_msg);
        }
      };
    }

    let html_asset = create_html_asset(
      &output_file_name,
      &before_emit_data.html,
      &template_file_name,
      compilation,
    )
    .await?;

    compilation.emit_asset(html_asset.0.clone(), html_asset.1);

    let _ = hooks
      .borrow()
      .after_emit
      .call(AfterEmitData {
        output_name: html_asset.0.clone(),
        compilation_id: compilation.id(),
        uid: config.uid,
      })
      .await?;
  }

  Ok(())
}

impl Plugin for HtmlRspackPlugin {
  fn name(&self) -> &'static str {
    "rspack.HtmlRspackPlugin"
  }

  fn apply(&self, ctx: &mut rspack_core::ApplyContext<'_>) -> Result<()> {
    ctx.compilation_hooks.full_hash.tap(full_hash::new(self));
    ctx
      .compilation_hooks
      .process_assets
      .tap(process_assets::new(self));
    Ok(())
  }

  fn clear_cache(&self, id: CompilationId) {
    COMPILATION_HOOKS_MAP.remove(&id);
  }
}

fn create_error_html(err: &str) -> String {
  format!(
    r#"Html Rspack Plugin:
    <pre>
      Error: {err}
    </pre>
    "#,
  )
}
