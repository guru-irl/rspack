// Appended to a scratch copy of the published sst_inspect.rs. No production
// crate, binding, capacity or codec is modified.
use serde_json::{json, Value};

fn be16(b: &[u8]) -> usize { u16::from_be_bytes(b[..2].try_into().unwrap()) as usize }
fn be32(b: &[u8]) -> usize { u32::from_be_bytes(b[..4].try_into().unwrap()) as usize }
fn compress_value(b: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    lzzzz::lz4::compress_to_vec(b, &mut out, lzzzz::lz4::ACC_LEVEL_DEFAULT)?;
    Ok(out)
}
fn val_size(t: u8) -> usize {
    match t { 0 => 8, 1 => 4, 2 => 0, 3 => 2, t if t >= 8 => (t - 8) as usize, _ => panic!("unknown entry type") }
}
fn entries(block: &[u8]) -> Vec<(Vec<u8>, u8, Vec<u8>)> {
    let n = ((block[1] as usize) << 16) | ((block[2] as usize) << 8) | block[3] as usize;
    let hash = if block[0] == BLOCK_TYPE_KEY_WITH_HASH || block[0] == BLOCK_TYPE_FIXED_KEY_WITH_HASH { 8 } else { 0 };
    let fixed = block[0] == BLOCK_TYPE_FIXED_KEY_WITH_HASH || block[0] == BLOCK_TYPE_FIXED_KEY_NO_HASH;
    (0..n).map(|i| {
        let (ty, key, val) = if fixed {
            let k = block[4] as usize;
            let ty = block[5];
            let stride = hash + k + val_size(ty);
            let start = 6 + i * stride;
            (ty, &block[start + hash..start + hash + k], &block[start + hash + k..start + stride])
        } else {
            let data = &block[4 + n * 4..];
            let h = &block[4 + i * 4..];
            let ty = h[0];
            let start = be32(h) & 0xffffff;
            let end = if i + 1 == n { data.len() } else { be32(&block[4 + (i + 1) * 4..]) & 0xffffff };
            (ty, &data[start + hash..end - val_size(ty)], &data[end - val_size(ty)..end])
        };
        (key.to_vec(), ty, val.to_vec())
    }).collect()
}
fn logical_family(physical: u32, key: &[u8]) -> String {
    if physical == 1 { return "validator".into(); }
    let key = std::str::from_utf8(key).expect("Rspack UTF-8 cache key");
    for family in ["Compilation/modules", "Compilation/codeGeneration", "ResolverCache", "loader", "meta", "rspack.SourceMapDevToolPlugin", "rspack.SwcJsMinimizerRspackPlugin"] {
        if key.split('|').any(|part| part == family) { return family.into(); }
    }
    format!("other:{}", key.split('|').nth(1).unwrap_or(key))
}
#[derive(Default)]
struct Values {
    count: u64, bytes: u64, min: usize, max: usize,
    hist: BTreeMap<String, (u64, u64)>, classes: BTreeMap<String, (u64, u64)>,
    lz4_bytes: u64, framed_bytes: u64, compressed_values: u64,
}
impl Values {
    fn add(&mut self, class: &str, b: &[u8], c: &[u8]) {
        if self.count == 0 { self.min = b.len(); } else { self.min = self.min.min(b.len()); }
        self.max = self.max.max(b.len()); self.count += 1; self.bytes += b.len() as u64;
        let bucket = match b.len() {
            0..=8 => "0..8", 9..=128 => "9..128", 129..=256 => "129..256", 257..=512 => "257..512",
            513..=1024 => "513..1024", 1025..=2048 => "1025..2048", 2049..=4096 => "2049..4096",
            4097..=8192 => "4097..8192", 8193..=16384 => "8193..16384", 16385..=65536 => "16385..65536",
            65537..=1048576 => "65537..1048576", 1048577..=67108864 => "1048577..67108864", _ => ">67108864",
        };
        for entry in [self.hist.entry(bucket.into()).or_default(), self.classes.entry(class.into()).or_default()] {
            entry.0 += 1; entry.1 += b.len() as u64;
        }
        self.lz4_bytes += c.len() as u64;
        self.framed_bytes += (8 + c.len().min(b.len())) as u64;
        self.compressed_values += u64::from(c.len() < b.len());
    }
    fn json(&self) -> Value { json!({"entries":self.count,"raw_bytes":self.bytes,"min":self.min,"max":self.max,
        "histogram":self.hist,"classes":self.classes,"lz4_bytes":self.lz4_bytes,"framed_bytes":self.framed_bytes,
        "compressed_values":self.compressed_values}) }
}
#[derive(Default)]
struct Blocks { count: u64, stored: u64, raw: u64, compressed: u64, compressed_raw: u64, uncompressed: u64, uncompressed_raw: u64 }
impl Blocks {
    fn add(&mut self, b: &RawBlock) {
        self.count += 1; self.stored += b.compressed_size; self.raw += b.actual_size;
        if b.was_compressed { self.compressed += 1; self.compressed_raw += b.actual_size; }
        else { self.uncompressed += 1; self.uncompressed_raw += b.actual_size; }
    }
    fn json(&self) -> Value { json!({"count":self.count,"stored_payload_bytes":self.stored,"raw_payload_bytes":self.raw,
        "compressed":self.compressed,"compressed_raw_bytes":self.compressed_raw,"uncompressed":self.uncompressed,
        "uncompressed_raw_bytes":self.uncompressed_raw,"headers_bytes":self.count*8}) }
}
#[derive(Default)]
struct Simulation { blocks: Blocks, buf: Vec<u8>, promoted: u64, promoted_bytes: u64 }
impl Simulation {
    fn put(&mut self, value: &[u8]) -> Result<()> {
        if value.len() > 4096 { self.promoted += 1; self.promoted_bytes += value.len() as u64; return Ok(()); }
        self.buf.extend_from_slice(value);
        if self.buf.len() >= 8192 { self.flush()?; }
        Ok(())
    }
    fn flush(&mut self) -> Result<()> {
        if self.buf.is_empty() { return Ok(()); }
        let c = compress_value(&self.buf)?;
        let raw = self.buf.len();
        let compressed = c.len() < raw - raw/8;
        self.blocks.add(&RawBlock { data: Box::new([]), compressed_size: if compressed { c.len() } else { raw } as u64,
            actual_size:raw as u64, was_compressed:compressed });
        self.buf.clear(); Ok(())
    }
    fn json(&self) -> Value { json!({"blocks":self.blocks.json(),"promoted_values":self.promoted,"promoted_encoded_bytes":self.promoted_bytes}) }
}
fn framed(b: &[u8], c: &[u8], header: usize) -> Vec<u8> {
    let chosen = if c.len() < b.len() { c } else { b };
    let mut out = Vec::with_capacity(chosen.len() + header);
    if header == 8 {
        out.extend_from_slice(&(b.len() as u32).to_be_bytes());
        let flag = if c.len() < b.len() { c.len() as u32 } else { (b.len() as u32) | 0x80000000 };
        out.extend_from_slice(&flag.to_be_bytes());
    }
    out.extend_from_slice(chosen); out
}
fn census_main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let db = Path::new(&args[1]);
    let infos = collect_sst_info(db)?;
    let mut families: BTreeMap<String, Values> = BTreeMap::new();
    let mut physical = BTreeMap::new();
    let mut blocks: BTreeMap<String, Blocks> = BTreeMap::new();
    let mut original_groups = Simulation::default();
    let mut repacked = Simulation::default();
    let mut payload_only = Simulation::default();
    let mut sst_bytes = 0u64;
    let mut seen = HashSet::new();
    let mut duplicate_keys = 0;
    let mut content_fingerprint = 0u64;
    let mut sst_manifest = Vec::new();
    for (&family, ssts) in &infos {
        let mut count = 0u64;
        for info in ssts {
            let file = File::open(db.join(format!("{:08}.sst", info.sequence_number)))?;
            let mmap = unsafe { Mmap::map(file.file())? };
            sst_bytes += mmap.len() as u64;
            sst_manifest.push(json!({"sequence":info.sequence_number,"bytes":mmap.len(),"family":family}));
            let offsets = mmap.len() - info.block_count as usize * 4;
            let index = read_block(&mmap, offsets, info.block_count - 1, info.sequence_number)?;
            let keys = parse_key_block_indices(&index.data);
            blocks.entry("index".into()).or_default().add(&index);
            let mut small: BTreeMap<u16, Vec<(usize,usize,String)>> = BTreeMap::new();
            let mut medium: BTreeMap<u16, String> = BTreeMap::new();
            for &idx in &keys {
                let kb = read_block(&mmap, offsets, idx, info.sequence_number)?;
                blocks.entry("key".into()).or_default().add(&kb);
                for (key, ty, val) in entries(&kb.data) {
                    count += 1;
                    if !seen.insert((family,key.clone())) { duplicate_keys += 1; }
                    let logical = logical_family(family,&key);
                    match ty {
                        0 => { small.entry(be16(&val) as u16).or_default().push((be32(&val[4..]),be16(&val[2..]),logical)); }
                        3 => { let previous = medium.insert(be16(&val) as u16,logical); assert!(previous.is_none()); }
                        2 => { families.entry("tombstone".into()).or_default().count += 1; }
                        t if t >= 8 => { let c = compress_value(&val)?; families.entry(logical).or_default().add("inline",&val,&c); }
                        1 => {
                            let blob = std::fs::read(db.join(format!("{:08}.blob",be32(&val))))?;
                            let size = be32(&blob[..4]); let crc = be32(&blob[4..8]) as u32;
                            assert_eq!(checksum_block(&blob[8..]),crc);
                            let mut value = vec![0;size]; assert_eq!(decompress(&blob[8..],&mut value)?,size);
                            let c = compress_value(&value)?; families.entry(logical).or_default().add("blob",&value,&c);
                        }
                        _ => bail!("unknown entry type"),
                    }
                }
            }
            for idx in 0..info.block_count - 1 {
                if keys.contains(&idx) { continue; }
                let b = read_block(&mmap,offsets,idx,info.sequence_number)?;
                if let Some(logical) = medium.remove(&idx) {
                    blocks.entry("medium".into()).or_default().add(&b);
                    let c = compress_value(&b.data)?;
                    families.entry(logical).or_default().add("medium",&b.data,&c);
                    content_fingerprint = content_fingerprint.wrapping_add(checksum_block(&b.data) as u64);
                } else if let Some(mut refs) = small.remove(&idx) {
                    blocks.entry("small".into()).or_default().add(&b);
                    refs.sort_by_key(|r| r.0);
                    let mut position = 0;
                    for (offset,len,logical) in refs {
                        assert_eq!(offset,position,"non-contiguous small refs"); position += len;
                        let value = &b.data[offset..offset+len];
                        let c = compress_value(value)?;
                        let mut decoded = vec![0;value.len()];
                        assert_eq!(decompress(&c,&mut decoded)?,value.len()); assert_eq!(value,&decoded);
                        families.entry(logical).or_default().add("small",value,&c);
                        content_fingerprint = content_fingerprint.wrapping_add(checksum_block(value) as u64);
                        let encoded = framed(value,&c,8);
                        original_groups.put(&encoded)?;
                        repacked.put(&encoded)?;
                        payload_only.put(&framed(value,&c,0))?;
                    }
                    assert_eq!(position,b.data.len(),"unreferenced small data");
                    original_groups.flush()?;
                } else { bail!("unclassified block {idx}"); }
            }
            assert!(small.is_empty() && medium.is_empty());
            repacked.flush()?; payload_only.flush()?;
        }
        physical.insert(family.to_string(),json!({"name":if family==0 {"cache"} else if family==1 {"validator"} else {"unknown"},"entries":count,"sst_files":ssts.len()}));
    }
    let mut files_by_extension: BTreeMap<String,(u64,u64)> = BTreeMap::new();
    for entry in std::fs::read_dir(db)? {
        let path = entry?.path();
        if path.is_file() { let ext = path.extension().and_then(|s|s.to_str()).unwrap_or("none").to_string();
            let e = files_by_extension.entry(ext).or_default(); e.0+=1; e.1+=path.metadata()?.len(); }
    }
    let output = json!({"physical_families":physical,"logical_families":families.iter().map(|(k,v)|(k.clone(),v.json())).collect::<BTreeMap<_,_>>(),
        "blocks":blocks.iter().map(|(k,v)|(k.clone(),v.json())).collect::<BTreeMap<_,_>>(),
        "simulation":{"framed8_original_groups":original_groups.json(),"framed8_repacked":repacked.json(),"payload_only_repacked":payload_only.json()},
        "active_sst_bytes":sst_bytes,"files_by_extension":files_by_extension,"sst_manifest":sst_manifest,
        "duplicate_physical_keys":duplicate_keys,"content_crc_sum":content_fingerprint,
        "method":"All physical values inspected and LZ4-compressed, not a sample. Small values roundtrip checked. LZ4 default acceleration. 8-byte independent-value framing with raw fallback; only originally-small values selected. Repack at >=8192 bytes, preserving SST boundaries/order. Demand includes only compressed small payload plus 8-byte cache weight per block. No production changes."});
    std::fs::write(&args[2],serde_json::to_vec_pretty(&output)?)?;
    Ok(())
}
fn main() -> Result<()> { census_main() }
