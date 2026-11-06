use std::{
  borrow::Cow,
  hash::{Hash, Hasher},
  io,
  sync::Arc,
};

use rspack_sources::{
  MapOptions, Source, SourceMap, SourceValue,
  stream_chunks::{Chunks, StreamChunks},
};

/// The size of an emitted asset whose content is no longer available.
#[derive(Debug, PartialEq, Eq)]
pub struct SizeOnlySource(usize);

impl SizeOnlySource {
  const UNAVAILABLE: &str =
    "Content and Map of this Source is not available (only size() is supported)";

  pub fn new(size: usize) -> Self {
    Self(size)
  }

  fn unavailable() -> ! {
    panic!("{}", Self::UNAVAILABLE)
  }
}

impl Hash for SizeOnlySource {
  fn hash<H: Hasher>(&self, _state: &mut H) {
    Self::unavailable()
  }
}

impl StreamChunks for SizeOnlySource {
  fn stream_chunks<'a>(&'a self) -> Box<dyn Chunks<'a> + 'a> {
    Self::unavailable()
  }
}

impl Source for SizeOnlySource {
  fn source(&self) -> SourceValue<'_> {
    Self::unavailable()
  }

  fn rope<'a>(&'a self, _on_chunk: &mut dyn FnMut(&'a str)) {
    Self::unavailable()
  }

  fn buffer(&self) -> Cow<'_, [u8]> {
    Self::unavailable()
  }

  fn size(&self) -> usize {
    self.0
  }

  fn map<'a>(&'a self, _options: &MapOptions) -> Option<SourceMap<'a>> {
    Self::unavailable()
  }

  fn map_static(self: Arc<Self>, _options: &MapOptions) -> Option<SourceMap<'static>> {
    Self::unavailable()
  }

  fn to_writer(&self, _writer: &mut dyn io::Write) -> io::Result<()> {
    Err(io::Error::other(Self::UNAVAILABLE))
  }
}
