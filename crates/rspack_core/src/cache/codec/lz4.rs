use lz4_flex::block::{compress_into, decompress_into, get_maximum_output_size};
use rayon::prelude::*;
use rspack_cacheable::rkyv::util::AlignedVec;
use rspack_error::{Result, error};

const CHUNK_SIZE: usize = 256 * 1024;
const RAW_CHUNK: u32 = 0x8000_0000;
// lz4_flex uses a 4K-entry u32 hash table for a full chunk.
const COMPRESSOR_TABLE_SIZE: usize = 4 * 1024 * size_of::<u32>();

/// Cache value format: `u32 LE decoded_len`, then independent 256 KiB chunks.
/// Each chunk starts with a `u32 LE word`: the high bit marks raw bytes and the
/// remaining bits give their length; otherwise the word is the LZ4 block length.
/// Raw blocks follow the LZ4 frame format's uncompressed-block convention.
/// Each chunk decodes to `min(256 KiB, remaining)` bytes, with no dictionary.
/// Empty values have only the size header; truncation and trailing bytes fail.
pub(super) fn encode(mut bytes: AlignedVec) -> Result<Vec<u8>> {
  let decoded_len = u32::try_from(bytes.len()).map_err(rspack_error::Error::from_error)?;
  let chunk_count = bytes.len().div_ceil(CHUNK_SIZE);
  let headers_size = 4 * chunk_count;
  let raw_size = bytes
    .len()
    .checked_add(headers_size)
    .and_then(|size| size.checked_add(4))
    .ok_or_else(|| error!("compressed cache value is too large"))?;
  let scratch_size = get_maximum_output_size(bytes.len().min(CHUNK_SIZE));
  let compressor_size = scratch_size + COMPRESSOR_TABLE_SIZE;
  // Stage payloads in the owned archive. Including length words and hash tables,
  // headers_size + K * compressor_size <= raw_size + compressor_size, the old
  // reservation plus one compressor. Assembly needs only headers_size + output,
  // with output <= raw_size and headers_size <= scratch_size for any u32 value.
  let parallel_chunks = if chunk_count > 1 {
    (1 + (raw_size - headers_size) / compressor_size).min(rayon::current_num_threads())
  } else {
    1
  };
  let mut words = Vec::new();
  words
    .try_reserve_exact(chunk_count)
    .map_err(rspack_error::Error::from_error)?;
  words.resize(chunk_count, 0u32);
  let encode_chunk = |(chunk, word): (&mut [u8], &mut u32)| -> Result<()> {
    let mut scratch = vec![0; get_maximum_output_size(chunk.len())];
    let compressed_len =
      compress_into(chunk, &mut scratch).map_err(rspack_error::Error::from_error)?;
    if compressed_len >= chunk.len() {
      *word = RAW_CHUNK | chunk.len() as u32;
    } else {
      chunk[..compressed_len].copy_from_slice(&scratch[..compressed_len]);
      *word = compressed_len as u32;
    }
    Ok(())
  };
  if chunk_count > 1 {
    for (chunks, words) in bytes
      .as_mut_slice()
      .chunks_mut(parallel_chunks * CHUNK_SIZE)
      .zip(words.chunks_mut(parallel_chunks))
    {
      chunks
        .par_chunks_mut(CHUNK_SIZE)
        .zip(words.par_iter_mut())
        .try_for_each(encode_chunk)?;
    }
  } else {
    bytes
      .as_mut_slice()
      .chunks_mut(CHUNK_SIZE)
      .zip(words.iter_mut())
      .try_for_each(encode_chunk)?;
  }
  let encoded_size = 4
    + words
      .iter()
      .map(|word| 4 + (word & !RAW_CHUNK) as usize)
      .sum::<usize>();
  let mut output = Vec::new();
  output
    .try_reserve_exact(encoded_size)
    .map_err(rspack_error::Error::from_error)?;
  output.extend_from_slice(&decoded_len.to_le_bytes());
  for (chunk, word) in bytes.chunks(CHUNK_SIZE).zip(words) {
    output.extend_from_slice(&word.to_le_bytes());
    output.extend_from_slice(&chunk[..(word & !RAW_CHUNK) as usize]);
  }
  Ok(output)
}

pub(super) fn decode(mut input: &[u8]) -> Result<AlignedVec> {
  let input_len = input.len();
  let decoded_len = read_word(&mut input)? as usize;
  // LZ4's maximum expansion is 255:1. Reject corrupt sizes before allocating.
  if decoded_len > input_len.saturating_mul(255) {
    return Err(error!("compressed cache value decoded size is too large"));
  }
  // Decode into an aligned buffer so deserialization reads it without a copy.
  let mut output = AlignedVec::with_capacity(decoded_len);
  output.resize(decoded_len, 0);
  for chunk in output.as_mut_slice().chunks_mut(CHUNK_SIZE) {
    let word = read_word(&mut input)?;
    let block_len = (word & !RAW_CHUNK) as usize;
    let raw = word & RAW_CHUNK != 0;
    if (raw && block_len != chunk.len())
      || (!raw && (block_len == 0 || block_len > get_maximum_output_size(chunk.len())))
    {
      return Err(error!("compressed cache value has an invalid chunk length"));
    }
    let block = take(&mut input, block_len)?;
    if raw {
      chunk.copy_from_slice(block);
    } else {
      let written = decompress_into(block, chunk).map_err(rspack_error::Error::from_error)?;
      if written != chunk.len() {
        return Err(error!("compressed cache value chunk decoded size mismatch"));
      }
    }
  }
  if !input.is_empty() {
    return Err(error!("compressed cache value has trailing bytes"));
  }
  Ok(output)
}

fn read_word(input: &mut &[u8]) -> Result<u32> {
  let bytes = take(input, 4)?;
  Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn take<'a>(input: &mut &'a [u8], len: usize) -> Result<&'a [u8]> {
  let (bytes, rest) = input
    .split_at_checked(len)
    .ok_or_else(|| error!("compressed cache value is truncated"))?;
  *input = rest;
  Ok(bytes)
}
