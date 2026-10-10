from pathlib import Path
import sys

capacity = {'p2-64': 64, 'p2-128': 128}[sys.argv[1]]
source = Path('scripts/newcache-memory/vendor/rspack-turbo-persistence/src/constants.rs')
text = source.read_text()
old = 'pub const VALUE_BLOCK_CACHE_SIZE: u64 = 300 * 1024 * 1024;'
assert old in text
source.write_text(text.replace(old, f'pub const VALUE_BLOCK_CACHE_SIZE: u64 = {capacity} * 1024 * 1024;'))
print(f'Value block cache target: {capacity} MiB')
