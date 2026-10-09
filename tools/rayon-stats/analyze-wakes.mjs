import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const counters = [
  'cold_ops', 'cold_ns', 'cross_ops', 'injected', 'wakes', 'sleeps',
  'hist_0_10_us', 'hist_10_30_us', 'hist_30_100_us', 'hist_100_300_us',
  'hist_300_1000_us', 'hist_1000_3000_us', 'hist_3000_inf_us',
  'user_cpu_ns', 'system_cpu_ns', 'voluntary_context_switches', 'minor_faults', 'major_faults',
];
export function parseSamples(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const header = lines.shift()?.split(',');
  if (!header || header[0] !== 'timestamp_ns' || counters.some(k => !header.includes(k))) throw new Error('Unexpected sample header');
  const samples = lines.map(line => {
    const fields = line.split(',');
    if (fields.length !== header.length) throw new Error('Incomplete sample');
    return Object.fromEntries(header.map((k, i) => [k, BigInt(fields[i])]));
  }).sort(byTime);
  if (samples.length < 2) throw new Error('At least two samples required');
  samples.os_regressions = [];
  for (let i = 1; i < samples.length; i++) for (const k of counters) {
    if (samples[i][k] < samples[i - 1][k]) {
      if (counters.indexOf(k) < 13) throw new Error('Counter reset: use separate files per process');
      samples.os_regressions.push({ field: k, previous: samples[i-1][k].toString(), current: samples[i][k].toString(), timestamp_ns: samples[i].timestamp_ns.toString() });
    }
  }
  return samples;
}
const byTime = (a, b) => a.timestamp_ns < b.timestamp_ns ? -1 : a.timestamp_ns > b.timestamp_ns ? 1 : 0;
export function parseMarks(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const m = JSON.parse(line);
    return { ...m, timestamp_ns: BigInt(m.timestamp_ns) };
  }).sort(byTime);
}
const ms = ns => Number(ns) / 1e6;
function predecessor(samples, t) {
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].timestamp_ns <= t) lo = mid + 1;
    else hi = mid;
  }
  return samples[Math.max(0, lo - 1)];
}
function overlap(intervals, start, end, own) {
  const parts = intervals.filter(x => x.id !== own && x.start < end && x.end > start)
    .map(x => [x.start > start ? x.start : start, x.end < end ? x.end : end])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  let total = 0n, left, right;
  for (const [a, b] of parts) {
    if (left === undefined) { left = a; right = b; }
    else if (a <= right) { if (b > right) right = b; }
    else { total += right - left; left = a; right = b; }
  }
  return total + (left === undefined ? 0n : right - left);
}
export function analyze(samples, marks) {
  marks = [...marks].sort(byTime);
  const jsGroups = new Map(), rustGroups = new Map(), warnings = [];
  for (const m of marks) {
    const id = m.compiler_id ?? m.compiler ?? 'unnamed';
    const rust = m.source === 'rust';
    const key = JSON.stringify([id, rust ? m.compilation_id : m.build]);
    const groups = rust ? rustGroups : jsGroups;
    if (!groups.has(key)) groups.set(key, { id, marks: [] });
    groups.get(key).marks.push(m);
  }
  const js = [...jsGroups.values()];
  for (const g of js) {
    g.start = g.marks.find(m => m.hook === 'compile');
    g.end = g.marks.find(m => m.hook === 'done');
    if (!g.start || !g.end) throw new Error(`Incomplete JS build for ${g.id}: compile/done required`);
  }
  const windows = [], rustBuilds = new Map(), matchedJs = new Set();
  for (const g of rustGroups.values()) {
    const pending = new Map(), pairs = [];
    for (const m of g.marks) {
      if (m.event === 'start') {
        if (pending.has(m.pass)) throw new Error(`Repeated open Rust pass: ${m.pass}`);
        pending.set(m.pass, m);
      } else if (m.event === 'end') {
        const start = pending.get(m.pass);
        if (!start) throw new Error(`Rust pass end without start: ${m.pass}`);
        pending.delete(m.pass); pairs.push([start, m]);
      }
    }
    if (pending.size || !pairs.length) throw new Error(`Incomplete Rust pass marks for ${g.id}`);
    g.start = pairs[0][0]; g.end = pairs.at(-1)[1];
    let candidates = js.filter(x => x.start.timestamp_ns <= g.start.timestamp_ns && x.end.timestamp_ns >= g.end.timestamp_ns && x.start.compiler === g.start.compiler);
    if (!candidates.length) candidates = js.filter(x => x.start.compiler == null && x.start.timestamp_ns <= g.start.timestamp_ns && x.end.timestamp_ns >= g.end.timestamp_ns);
    if (candidates.length > 1) {
      const ids = pairs.find(([a]) => a.pass === 'module ids');
      if (ids) candidates = candidates.filter(x => x.marks.some(m => m.hook === 'beforeModuleIds' && m.timestamp_ns >= ids[0].timestamp_ns && m.timestamp_ns <= ids[1].timestamp_ns));
    }
    const context = candidates.length === 1 ? candidates[0] : null;
    if (context) matchedJs.add(context);
    else warnings.push(`No unique JS outer-build match for ${g.id}/${g.start.compilation_id}; use unique compiler config names for complete outer attribution`);
    const ordinal = (rustBuilds.get(g.id) ?? 0) + 1; rustBuilds.set(g.id, ordinal);
    g.canonicalId = context?.id ?? g.id;
    g.context = context;
    for (const [a, b] of pairs) windows.push({ a, b, id: g.canonicalId, context: context?.start, ordinal, source: 'rust', window: a.pass, unmatched: !context });
  }
  // Rust pass rows and only non-overlapping outer JS intervals are primary windows.
  for (const g of js) {
    const ownRust = [...rustGroups.values()].filter(x => x.context === g);
    if (ownRust.length) {
      const first = ownRust[0].start, last = ownRust.at(-1).end;
      windows.push({ a: g.start, b: first, id: g.id, context: g.start, source: 'js', window: 'compile -> Rust passes' });
      windows.push({ a: last, b: g.end, id: g.id, context: g.start, source: 'js', window: 'Rust passes -> done' });
      const afterCompile = g.marks.find(m => m.hook === 'afterCompile');
      const emit = g.marks.find(m => m.hook === 'emit');
      const afterEmit = g.marks.find(m => m.hook === 'afterEmit');
      // Detail rows overlap the outer tail, and are explicitly identified.
      for (const [a,b] of [[last,afterCompile],[afterCompile,emit],[emit,afterEmit],[afterEmit,g.end]]) {
        if (a && b) windows.push({ a,b,id:g.id,context:g.start,source:'js',window:`${a.hook} -> ${b.hook}`,detail:true });
      }
    } else {
      const unique = g.marks.filter((m,i,list) => i === 0 || m.hook !== list[i-1].hook);
      for (let i=0;i+1<unique.length;i++) windows.push({ a:unique[i],b:unique[i+1],id:g.id,context:g.start,source:'js',window:`${unique[i].hook} -> ${unique[i+1].hook}` });
    }
  }
  const intervals = js.map(g => ({ id:g.id,start:g.start.timestamp_ns,end:g.end.timestamp_ns }));
  for (const g of rustGroups.values()) if (!g.context) intervals.push({ id:g.id,start:g.start.timestamp_ns,end:g.end.timestamp_ns });
  let maxGap = 0n;
  if (samples) for (let i=1;i<samples.length;i++) {
    const gap=samples[i].timestamp_ns-samples[i-1].timestamp_ns;if(gap>maxGap)maxGap=gap;
  }
  const rows = windows.map(({a,b,id,context,ordinal,source,window,unmatched,detail}) => {
    const start=a.timestamp_ns,end=b.timestamp_ns;
    if(end<start)throw new Error('Negative window');
    const wallMs=ms(end-start),overlapMs=ms(overlap(intervals,start,end,id));
    const row={ compiler:context?.compiler??a.compiler,compiler_id:id,build:context?.build??ordinal??a.build,
      compilation_id:a.compilation_id??null,run:context?.run??null,
      phase:context?.phase??((context?.build??ordinal??a.build)===1?'cold':'rebuild'),
      source,window,detail:!!detail,unmatched:!!unmatched,start_ns:start.toString(),end_ns:end.toString(),wall_ms:wallMs,
      overlap_ms:overlapMs,overlap_pct:wallMs>0?overlapMs/wallMs*100:0,overlap_flag:wallMs>0&&overlapMs/wallMs>0.1 };
    if(samples) {
      const first=predecessor(samples,start),last=predecessor(samples,end);
      for(const k of counters)row[k]=Number(last[k]-first[k]);
      row.os_counter_regression = counters.slice(13).some(k => row[k] < 0) || (samples.os_regressions??[]).some(x => BigInt(x.timestamp_ns)>=first.timestamp_ns && BigInt(x.timestamp_ns)<=last.timestamp_ns);
      Object.assign(row,{ user_cpu_ms:row.user_cpu_ns/1e6,system_cpu_ms:row.system_cpu_ns/1e6,
        cold_share_pct:wallMs>0?row.cold_ns/1e6/wallMs*100:0,wakes_per_ms:wallMs>0?row.wakes/wallMs:0,cold_ops_per_ms:wallMs>0?row.cold_ops/wallMs:0,
        start_sample_skew_ms:ms(start-first.timestamp_ns),end_sample_skew_ms:ms(end-last.timestamp_ns),sampling_limited:end-start<maxGap,
        sample_clipped:start<samples[0].timestamp_ns||end>samples.at(-1).timestamp_ns });
    }
    return row;
  });
  return { sampling:samples?{method:'preceding cumulative sample at each exact boundary',max_gap_ms:ms(maxGap),os_regressions:samples.os_regressions??[]}:null,warnings,rows };
}
function csv(rows) {
  const keys=Object.keys(rows[0]??{}),quote=x=>JSON.stringify(String(x??''));
  return [keys.map(quote).join(','),...rows.map(r=>keys.map(k=>quote(r[k])).join(','))].join('\n')+'\n';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [samplesFile,marksFile,out]=process.argv.slice(2);
  if(!samplesFile||!marksFile)throw new Error('Usage: node analyze-wakes.mjs samples.csv|- marks.jsonl [output-prefix]');
  const report=analyze(samplesFile==='-'?null:parseSamples(fs.readFileSync(samplesFile,'utf8')),parseMarks(fs.readFileSync(marksFile,'utf8')));
  if(out){fs.writeFileSync(`${out}.json`,JSON.stringify(report,null,2)+'\n');fs.writeFileSync(`${out}.csv`,csv(report.rows));}
  else console.log(JSON.stringify(report,null,2));
}
