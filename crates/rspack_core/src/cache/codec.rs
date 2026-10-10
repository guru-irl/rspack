use std::path::Path;

use rspack_cacheable::{
  __private::rkyv::{Archive, Deserialize, Serialize, bytecheck::CheckBytes},
  Deserializer, Serializer, Validator, from_bytes, to_bytes,
};
use rspack_error::Result;
use rspack_paths::Utf8PathBuf;

/// Internal cacheable context for serialization
#[derive(Debug, Clone)]
struct Context {
  portable_project_root: Option<Utf8PathBuf>,
}

impl rspack_cacheable::CacheableContext for Context {
  fn project_root(&self) -> Option<&Path> {
    self.portable_project_root.as_ref().map(|p| p.as_std_path())
  }
}

/// Cache codec for encoding and decoding cacheable data
///
/// This struct encapsulates the serialization and deserialization logic,
/// automatically passing the project context to rspack_cacheable's to_bytes and from_bytes.
///
/// # Example
///
/// ```ignore
/// let codec = CacheCodec::new(portable_project_root);
///
/// // Encode data to bytes
/// let bytes = codec.encode(&my_data)?;
///
/// // Decode bytes back to data
/// let my_data: MyType = codec.decode(&bytes)?;
/// ```
#[derive(Debug, Clone)]
pub struct CacheCodec {
  context: Context,
}

impl CacheCodec {
  pub fn new(portable_project_root: Option<Utf8PathBuf>) -> Self {
    Self {
      context: Context {
        portable_project_root,
      },
    }
  }

  pub fn encode<T>(&self, data: &T) -> Result<Vec<u8>>
  where
    T: for<'a> Serialize<Serializer<'a>>,
  {
    to_bytes(data, &self.context).map_err(rspack_error::Error::from_error)
  }

  #[cfg(not(target_family = "wasm"))]
  pub(crate) fn encode_small_value<T>(&self, data: &T) -> Result<Vec<u8>>
  where
    T: for<'a> Serialize<Serializer<'a>>,
  {
    let archive = rspack_cacheable::to_aligned_bytes(data, &self.context)
      .map_err(rspack_error::Error::from_error)?;
    let len = u32::try_from(archive.len())
      .map_err(|_| rspack_error::error!("Cache archive exceeds u32 framing limit"))?;
    let mut compressed = Vec::new();
    if (9..=4096).contains(&archive.len()) {
      lzzzz::lz4::compress_to_vec(&archive, &mut compressed, lzzzz::lz4::ACC_LEVEL_DEFAULT)
        .map_err(rspack_error::Error::from_error)?;
    }
    let use_compressed = !compressed.is_empty() && compressed.len() + 8 < archive.len();
    let payload: &[u8] = if use_compressed { &compressed } else { &archive };
    let mut bytes = Vec::with_capacity(payload.len() + 8);
    bytes.extend_from_slice(&len.to_le_bytes());
    bytes.extend_from_slice(&u32::from(use_compressed).to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
  }

  #[cfg(target_family = "wasm")]
  pub(crate) fn encode_small_value<T>(&self, data: &T) -> Result<Vec<u8>>
  where
    T: for<'a> Serialize<Serializer<'a>>,
  {
    self.encode(data)
  }

  #[cfg(not(target_family = "wasm"))]
  pub(crate) fn decode_small_value<T>(&self, bytes: &[u8]) -> Result<T>
  where
    T: Archive,
    T::Archived: for<'a> CheckBytes<Validator<'a>> + Deserialize<T, Deserializer>,
  {
    if bytes.len() < 8 {
      return Err(rspack_error::error!("Truncated cache value header"));
    }
    let len = u32::from_le_bytes(bytes[0..4].try_into().expect("four-byte length")) as usize;
    let mode = u32::from_le_bytes(bytes[4..8].try_into().expect("four-byte mode"));
    let payload = &bytes[8..];
    match mode {
      0 if payload.len() == len => self.decode(payload),
      1 if (9..=4096).contains(&len) && bytes.len() < len => {
        let mut archive = rspack_cacheable::__private::rkyv::util::AlignedVec::<16>::with_capacity(len);
        archive.resize(len, 0);
        let decoded = lzzzz::lz4::decompress(payload, &mut archive)
          .map_err(rspack_error::Error::from_error)?;
        if decoded != len {
          return Err(rspack_error::error!("Cache value decoded length mismatch"));
        }
        self.decode(&archive)
      }
      _ => Err(rspack_error::error!("Invalid cache value framing")),
    }
  }

  #[cfg(target_family = "wasm")]
  pub(crate) fn decode_small_value<T>(&self, bytes: &[u8]) -> Result<T>
  where
    T: Archive,
    T::Archived: for<'a> CheckBytes<Validator<'a>> + Deserialize<T, Deserializer>,
  {
    self.decode(bytes)
  }

  pub fn decode<T>(&self, bytes: &[u8]) -> Result<T>
  where
    T: Archive,
    T::Archived: for<'a> CheckBytes<Validator<'a>> + Deserialize<T, Deserializer>,
  {
    from_bytes(bytes, &self.context).map_err(rspack_error::Error::from_error)
  }
}
