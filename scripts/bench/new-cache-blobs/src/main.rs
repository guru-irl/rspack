//! Synthetic repro: blob files accumulate in rspack-turbo-persistence 0.1.1 when
//! values above the blob threshold (MAX_MEDIUM_VALUE_SIZE = 64 MiB) are overwritten
//! across idle stores, using rspack's own CompactConfig and idle compaction loop.
//!
//! Each "cycle" mimics one rspack idle store (file_cache_strategy.rs:after_all_stored_impl):
//!   1. one write batch: overwrite every huge key + `--churn-keys` filler keys, commit
//!   2. up to `--passes` (rspack: MAX_IDLE_COMPACTION_PASSES = 10) compact() calls
//! then prints one CSV row with file counts/sizes taken from the directory.
//!
//! Usage:
//!   blob-repro --dir <db dir> [--mode rspack|full] [--cycles 20] [--huge-keys 3]
//!              [--huge-mib 65] [--filler-mib 0] [--filler-value-kib 16]
//!              [--churn-keys 0] [--passes 10] [--reopen-each-cycle]
//!
//! `--mode rspack` uses rspack's COMPACT_CONFIG (crates/rspack_core/src/new_cache/db/turbo.rs:26).
//! `--mode full` uses a merge-everything config, as the control.

use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
  time::Instant,
};

use anyhow::{Context, Result, bail, ensure};
use turbo_persistence::{
  CompactConfig, DbConfig, FamilyConfig, FamilyKind, SerialScheduler, TurboPersistence,
};

const MIB: u64 = 1024 * 1024;
/// MAX_MEDIUM_VALUE_SIZE in the crate (src/constants.rs:2). Values strictly larger become blobs.
const BLOB_THRESHOLD: usize = 64 * 1024 * 1024;

/// Copied from crates/rspack_core/src/new_cache/db/turbo.rs (fork main cc7940ac).
const RSPACK_COMPACT: CompactConfig = CompactConfig {
  min_merge_count: 3,
  optimal_merge_count: 8,
  max_merge_count: 64,
  max_merge_bytes: 512 * MIB,
  min_merge_duplication_bytes: 50 * MIB,
  optimal_merge_duplication_bytes: 100 * MIB,
  max_merge_segment_count: 1,
};

/// Control: merge every overlapping SST into one job (a "full compaction").
const FULL_COMPACT: CompactConfig = CompactConfig {
  min_merge_count: 2,
  optimal_merge_count: usize::MAX,
  max_merge_count: usize::MAX,
  max_merge_bytes: u64::MAX,
  min_merge_duplication_bytes: 0,
  optimal_merge_duplication_bytes: u64::MAX,
  max_merge_segment_count: usize::MAX,
};

type Db = TurboPersistence<SerialScheduler, 2>;

fn db_config() -> DbConfig<2> {
  // Same families as rspack (db/turbo.rs database_config).
  DbConfig {
    family_configs: [
      FamilyConfig {
        name: "cache",
        kind: FamilyKind::SingleValue,
      },
      FamilyConfig {
        name: "validator",
        kind: FamilyKind::SingleValue,
      },
    ],
  }
}

struct Args {
  dir: PathBuf,
  mode: String,
  cycles: u32,
  huge_keys: u32,
  huge_mib: u64,
  filler_mib: u64,
  filler_value_kib: u64,
  churn_keys: u32,
  passes: u32,
  reopen_each_cycle: bool,
}

fn parse_args() -> Result<Args> {
  let mut map = HashMap::new();
  let mut flags = Vec::new();
  let mut it = std::env::args().skip(1);
  while let Some(arg) = it.next() {
    let Some(name) = arg.strip_prefix("--") else {
      bail!("unexpected argument {arg}");
    };
    if name == "reopen-each-cycle" {
      flags.push(name.to_string());
      continue;
    }
    let value = it
      .next()
      .with_context(|| format!("missing value for --{name}"))?;
    map.insert(name.to_string(), value);
  }
  let get = |name: &str, default: &str| -> String {
    map
      .get(name)
      .cloned()
      .unwrap_or_else(|| default.to_string())
  };
  let args = Args {
    dir: PathBuf::from(map.get("dir").context("--dir is required")?),
    mode: get("mode", "rspack"),
    cycles: get("cycles", "20").parse()?,
    huge_keys: get("huge-keys", "3").parse()?,
    huge_mib: get("huge-mib", "65").parse()?,
    filler_mib: get("filler-mib", "0").parse()?,
    filler_value_kib: get("filler-value-kib", "16").parse()?,
    churn_keys: get("churn-keys", "0").parse()?,
    passes: get("passes", "10").parse()?,
    reopen_each_cycle: flags.iter().any(|f| f == "reopen-each-cycle"),
  };
  ensure!(
    (args.huge_mib * MIB) as usize > BLOB_THRESHOLD,
    "--huge-mib must be > 64 so the values become blob files"
  );
  ensure!(
    args.mode == "rspack" || args.mode == "full",
    "--mode is rspack|full"
  );
  Ok(args)
}

/// Deterministic incompressible bytes (xorshift64*), so on-disk sizes match logical sizes.
fn random_bytes(seed: u64, len: usize) -> Vec<u8> {
  let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
  let mut out = Vec::with_capacity(len + 8);
  while out.len() < len {
    state ^= state >> 12;
    state ^= state << 25;
    state ^= state >> 27;
    out.extend_from_slice(&state.wrapping_mul(0x2545_F491_4F6C_DD1D).to_le_bytes());
  }
  out.truncate(len);
  out
}

fn huge_key(i: u32) -> Vec<u8> {
  // Shaped like rspack's asset-keyed caches, e.g. "<compiler>|SourceMapDevToolPlugin|<filename>".
  format!("server|SourceMapDevToolPlugin|server/chunk-{i}.js").into_bytes()
}

fn filler_key(i: u64) -> Vec<u8> {
  format!("server|Compilation/modules|/app/src/feature/module-{i:07}.tsx").into_bytes()
}

#[derive(Default)]
struct DirStats {
  blob_files: u64,
  blob_bytes: u64,
  sst_files: u64,
  sst_bytes: u64,
  meta_files: u64,
  del_files: u64,
  total_bytes: u64,
}

fn dir_stats(dir: &Path) -> Result<DirStats> {
  let mut s = DirStats::default();
  for entry in fs::read_dir(dir)? {
    let entry = entry?;
    let len = entry.metadata()?.len();
    s.total_bytes += len;
    match entry.path().extension().and_then(|e| e.to_str()) {
      Some("blob") => {
        s.blob_files += 1;
        s.blob_bytes += len;
      }
      Some("sst") => {
        s.sst_files += 1;
        s.sst_bytes += len;
      }
      Some("meta") => s.meta_files += 1,
      Some("del") => s.del_files += 1,
      _ => {}
    }
  }
  Ok(s)
}

fn open(dir: &Path) -> Result<Db> {
  Db::open_with_config(dir.to_path_buf(), db_config())
}

fn compact_passes(db: &Db, cfg: &CompactConfig, passes: u32) -> Result<u32> {
  let mut ran = 0;
  for _ in 0..passes {
    // rspack ignores the return value and always loops; None means nothing to do, and the
    // selection is deterministic for an unchanged DB, so stopping early is equivalent.
    match db.compact(cfg)? {
      Some(_) => ran += 1,
      None => break,
    }
  }
  Ok(ran)
}

fn verify_huge(db: &Db, seeds: &[u64], len: usize, cycle: u32) -> Result<()> {
  for (i, seed) in seeds.iter().enumerate() {
    let value = db
      .get(0, &huge_key(i as u32))?
      .with_context(|| format!("huge key {i} missing after cycle {cycle}"))?;
    ensure!(
      value.as_ref() == random_bytes(*seed, len).as_slice(),
      "huge key {i}: wrong content after cycle {cycle}"
    );
  }
  Ok(())
}

fn main() -> Result<()> {
  let args = parse_args()?;
  if args.dir.exists() {
    bail!("{} exists; pass a fresh directory", args.dir.display());
  }
  let cfg = if args.mode == "full" {
    FULL_COMPACT
  } else {
    RSPACK_COMPACT
  };
  let huge_len = (args.huge_mib * MIB) as usize;
  let filler_len = (args.filler_value_kib * 1024) as usize;
  let filler_count = if args.filler_mib == 0 {
    0
  } else {
    args.filler_mib * 1024 / args.filler_value_kib
  };
  // Expected content seed of every huge key, to verify reads after each cycle.
  let mut huge_seed: Vec<u64> = (0..args.huge_keys)
    .map(|i| 1_000_000 + u64::from(i))
    .collect();

  let mut db = open(&args.dir)?;
  println!(
    "mode,cycle,compactions,blob_files,live_blobs,dead_blobs,blob_mib,sst_files,sst_mib,meta_files,del_files,total_mib,store_ms,compact_ms,commit_us,blob_bytes,total_bytes"
  );

  // Cycle 0: initial store (all filler + all huge keys in one batch, like a cold build).
  let report = |db_dir: &Path,
                cycle: u32,
                compactions: u32,
                store_ms: u128,
                compact_ms: u128,
                commit_us: u128|
   -> Result<()> {
    let s = dir_stats(db_dir)?;
    let live = u64::from(args.huge_keys);
    println!(
      "{},{cycle},{compactions},{},{live},{},{:.1},{},{:.1},{},{},{:.1},{store_ms},{compact_ms},{commit_us},{},{}",
      args.mode,
      s.blob_files,
      s.blob_files.saturating_sub(live),
      s.blob_bytes as f64 / MIB as f64,
      s.sst_files,
      s.sst_bytes as f64 / MIB as f64,
      s.meta_files,
      s.del_files,
      s.total_bytes as f64 / MIB as f64,
      s.blob_bytes,
      s.total_bytes,
    );
    Ok(())
  };

  let t = Instant::now();
  let commit_us;
  {
    let batch = db.write_batch::<Vec<u8>>()?;
    for i in 0..filler_count {
      batch.put(0, filler_key(i), random_bytes(i + 1, filler_len).into())?;
    }
    for (i, seed) in huge_seed.iter().enumerate() {
      batch.put(0, huge_key(i as u32), random_bytes(*seed, huge_len).into())?;
    }
    batch.put(1, b"validator".to_vec(), random_bytes(7, 4096).into())?;
    let commit_start = Instant::now();
    db.commit_write_batch(batch)?;
    commit_us = commit_start.elapsed().as_micros();
  }
  let store_ms = t.elapsed().as_millis();
  let t = Instant::now();
  let ran = compact_passes(&db, &cfg, args.passes)?;
  let compact_ms = t.elapsed().as_millis();
  verify_huge(&db, &huge_seed, huge_len, 0)?;
  report(&args.dir, 0, ran, store_ms, compact_ms, commit_us)?;

  let mut churn_rng: u64 = 0xC0FFEE;
  for cycle in 1..=args.cycles {
    if args.reopen_each_cycle {
      db.shutdown()?;
      drop(db);
      db = open(&args.dir)?;
      verify_huge(&db, &huge_seed, huge_len, cycle - 1)?;
    }
    let t = Instant::now();
    let commit_us;
    {
      let batch = db.write_batch::<Vec<u8>>()?;
      for (i, seed) in huge_seed.iter_mut().enumerate() {
        *seed = u64::from(cycle) * 1_000_000 + i as u64;
        batch.put(0, huge_key(i as u32), random_bytes(*seed, huge_len).into())?;
      }
      if filler_count > 0 {
        for _ in 0..args.churn_keys {
          churn_rng ^= churn_rng << 13;
          churn_rng ^= churn_rng >> 7;
          churn_rng ^= churn_rng << 17;
          let i = churn_rng % filler_count;
          batch.put(0, filler_key(i), random_bytes(churn_rng, filler_len).into())?;
        }
      }
      let commit_start = Instant::now();
      db.commit_write_batch(batch)?;
      commit_us = commit_start.elapsed().as_micros();
    }
    let store_ms = t.elapsed().as_millis();
    let t = Instant::now();
    let ran = compact_passes(&db, &cfg, args.passes)?;
    let compact_ms = t.elapsed().as_millis();

    verify_huge(&db, &huge_seed, huge_len, cycle)?;
    report(&args.dir, cycle, ran, store_ms, compact_ms, commit_us)?;
  }
  db.shutdown()?;
  drop(db);
  let db = open(&args.dir)?;
  verify_huge(&db, &huge_seed, huge_len, args.cycles)?;
  db.shutdown()?;
  eprintln!("read-back passed: every cycle and final reopen");
  Ok(())
}
