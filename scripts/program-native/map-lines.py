import collections
import json
import os
import pathlib
import re
import struct
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
binary = pathlib.Path('crates/node_binding/rspack.linux-x64-gnu.node')
data = binary.read_bytes()
header = struct.unpack_from('<16sHHIQQQIHHHHHH', data)
segments = []
for i in range(header[10]):
    fields = struct.unpack_from('<IIQQQQQQ', data, header[5] + i * header[9])
    kind, flags, offset, vaddr, _, filesz, memsz, align = fields
    if kind == 1:
        segments.append((offset, vaddr, filesz))
del data
print('ELF LOAD SEGMENTS', segments)
all_results = []
for directory in sorted(root.glob('repeat-*')):
    metrics = json.load(open(directory / 'metrics.json'))
    maps = []
    raw_maps = (directory / 'mmap.txt').read_text(errors='replace')
    for line in raw_maps.splitlines():
        if binary.name not in line:
            continue
        print('BINDING MMAP', directory.name, line)
        match = re.search(r'\[(0x[0-9a-f]+)\((0x[0-9a-f]+)\)\s+@\s+(0x[0-9a-f]+)', line)
        if match:
            maps.append(tuple(int(x, 16) for x in match.groups()))
    if not maps:
        raise SystemExit('Binding mmap metadata not parsed')
    addresses = collections.Counter()
    names = {}
    measured = False
    for line in (directory / 'perf.script').read_text(errors='replace').splitlines():
        time = re.search(r'\s(\d+\.\d+):\s', line)
        if time and not line[0].isspace():
            measured = metrics['marks']['buildStart'] <= float(time.group(1)) <= metrics['marks']['buildEnd']
            continue
        if not measured or binary.name not in line:
            continue
        match = re.match(r'\s*([0-9a-f]+)\s+(.+)\s+\((.+)\)\s*$', line)
        if not match:
            continue
        ip = int(match.group(1), 16)
        for start, length, file_offset in maps:
            if start <= ip < start + length:
                file_pc = ip - start + file_offset
                for offset, vaddr, size in segments:
                    if offset <= file_pc < offset + size:
                        address = file_pc - offset + vaddr
                        addresses[address] += 1
                        names[address] = match.group(2)
                        break
                break
    selected = addresses.most_common(45)
    print('SAMPLED BINDING ADDRESSES', directory.name, len(addresses), 'selected', len(selected))
    symbolizer = os.environ['ADDR2LINE'].replace('addr2line', 'symbolizer')
    process = subprocess.run([symbolizer, '--obj=' + str(binary), '--inlining', '--demangle', '--output-style=JSON'], input=''.join(hex(addr) + '\n' for addr, count in selected), text=True, capture_output=True, timeout=180, check=True)
    if process.stderr:
        print('SYMBOLIZER STDERR', process.stderr[:1000])
    decoder = json.JSONDecoder()
    text = process.stdout.strip()
    records = []
    while text:
        value, end = decoder.raw_decode(text)
        records.extend(value if isinstance(value, list) else [value])
        text = text[end:].lstrip()
    for record, (address, count) in zip(records, selected):
        item = {'repeat': directory.name, 'address': hex(address), 'count': count, 'perfSymbol': names[address], 'llvm': record}
        all_results.append(item)
        for frame in record.get('Symbol', []):
            file = frame.get('FileName', '')
            line = frame.get('Line', 0)
            if file.endswith('.rs') and line:
                print('SOURCE', directory.name, count, hex(address), f'{file}:{line}', frame.get('FunctionName', '')[:160])
(root / 'address-lines.json').write_text(json.dumps(all_results, indent=2))
if not any(frame.get('Line', 0) for item in all_results for frame in item['llvm'].get('Symbol', [])):
    raise SystemExit('No binding debug line resolved')
