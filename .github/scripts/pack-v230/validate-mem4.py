import json
import sys

lines = [json.loads(line) for line in open(sys.argv[1])]
assert len(lines) == 3, f'expected 3 done records, got {len(lines)}'

def check_map(m):
    assert all(type(m[k]) is int and m[k] >= 0 for k in ('len', 'some', 'capacity'))
    assert m['some'] <= m['len'] <= m['capacity']
    if 'storage' in m:
        assert m['storage'] in ('dense', 'sparse')
        assert type(m['index_len']) is int and m['index_len'] >= m['len']
        if m['storage'] == 'dense':
            assert m['index_len'] == m['len']

assert [line['seq'] for line in lines] == [1, 2, 3]
assert [line['kind'] for line in lines] == ['build', 'rebuild', 'rebuild']
for line in lines:
    assert line['event'] == 'native_build_complete'
    assert type(line['ts_ms']) is int and line['ts_ms'] > 0
    assert line['compiler'] is None or isinstance(line['compiler'], str)
    assert isinstance(line['compiler_path'], str) and 'child' not in line
    for key in ('current_rss', 'peak_rss', 'current_commit', 'peak_commit', 'page_faults'):
        assert type(line[key]) is int and line[key] >= 0
    assert type(line['os_rss']) is int and line['os_rss'] > 0
    graph = line['module_graph']
    for key in ('dep_meta_map', 'connection_to_condition'):
        check_map(graph[key])
    for key in ('connections', 'dependency_id_to_connection_id'):
        m = graph[key]
        check_map(m['base'])
        check_map(m['overlay'])
        assert 0 <= m['same_values'] <= m['both_values'] <= min(m['base']['some'], m['overlay_values'])
        assert m['overlay_values'] <= m['overlay']['some']
print('validated 3 diagnostic records')
