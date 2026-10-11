use lz4_flex::block::{compress, decompress_into};
use rspack_cacheable::rkyv::util::AlignedVec;
use rspack_error::{Result, error};

const MAX_COMPRESSED_VALUE_SIZE: usize = 4096;
const TRAILER_SIZE: usize = 8;
const RAW: u32 = 0x7fff_ff00;
const LZ4: u32 = 0x7fff_ff01;

// The trailer preserves raw archive alignment. Its last word is deliberately
// not a valid archived Arc offset: StoredCacheEntry ends in a backward pointer,
// while either tag points past the end. Untagged entries therefore cannot be
// mistaken for this representation, even when builds share a cache identity.
// Layout: payload, u32 LE decoded length (zero for raw), u32 LE encoding tag.
pub(super) fn encode(archive: AlignedVec) -> Vec<u8> {
  if (9..=MAX_COMPRESSED_VALUE_SIZE).contains(&archive.len()) {
    let mut compressed = compress(&archive);
    if compressed.len() + TRAILER_SIZE < archive.len() {
      compressed.extend_from_slice(&(archive.len() as u32).to_le_bytes());
      compressed.extend_from_slice(&LZ4.to_le_bytes());
      // Do not retain the compression buffer's archive-sized spare capacity.
      return compressed.into_boxed_slice().into_vec();
    }
  }

  let mut bytes = Vec::with_capacity(archive.len() + TRAILER_SIZE);
  bytes.extend_from_slice(&archive);
  bytes.extend_from_slice(&0u32.to_le_bytes());
  bytes.extend_from_slice(&RAW.to_le_bytes());
  bytes
}

pub(super) enum DecodedValue<'a> {
  Raw(&'a [u8]),
  Compressed(AlignedVec),
}

impl AsRef<[u8]> for DecodedValue<'_> {
  fn as_ref(&self) -> &[u8] {
    match self {
      Self::Raw(bytes) => bytes,
      Self::Compressed(bytes) => bytes,
    }
  }
}

pub(super) fn decode(bytes: &[u8]) -> Result<DecodedValue<'_>> {
  let trailer_start = bytes
    .len()
    .checked_sub(TRAILER_SIZE)
    .ok_or_else(|| error!("Truncated cache value encoding"))?;
  let (payload, trailer) = bytes.split_at(trailer_start);
  let len = u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]) as usize;
  let tag = u32::from_le_bytes([trailer[4], trailer[5], trailer[6], trailer[7]]);
  match tag {
    RAW if len == 0 => Ok(DecodedValue::Raw(payload)),
    LZ4 if (9..=MAX_COMPRESSED_VALUE_SIZE).contains(&len) && bytes.len() < len => {
      let mut archive = AlignedVec::<16>::with_capacity(len);
      archive.resize(len, 0);
      let decoded =
        decompress_into(payload, &mut archive).map_err(rspack_error::Error::from_error)?;
      if decoded != len {
        return Err(error!("Cache value decoded length mismatch"));
      }
      Ok(DecodedValue::Compressed(archive))
    }
    _ => Err(error!("Invalid cache value encoding")),
  }
}
