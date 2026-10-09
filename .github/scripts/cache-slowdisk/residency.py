import ctypes
import os
from pathlib import Path


def residency(root):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
    libc.mmap.restype = ctypes.c_void_p
    libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    page_size = os.sysconf('SC_PAGE_SIZE')
    pages = resident = files = total_bytes = 0
    details = []
    for path in sorted(Path(root).rglob('*')):
        if not path.is_file():
            continue
        size = path.stat().st_size
        files += 1
        total_bytes += size
        if not size:
            continue
        count = (size + page_size - 1) // page_size
        fd = os.open(path, os.O_RDONLY)
        try:
            address = libc.mmap(None, size, 1, 1, fd, 0)
            if address == ctypes.c_void_p(-1).value:
                raise OSError(ctypes.get_errno(), 'mmap')
            try:
                vector = (ctypes.c_ubyte * count)()
                if libc.mincore(address, size, vector) != 0:
                    raise OSError(ctypes.get_errno(), 'mincore')
                hits = sum(value & 1 for value in vector)
                resident += hits
                pages += count
                details.append({'file': str(path.relative_to(root)), 'pages': count, 'resident': hits})
            finally:
                libc.munmap(address, size)
        finally:
            os.close(fd)
    if not pages:
        raise RuntimeError('empty cache residency probe')
    return {'files': files, 'bytes': total_bytes, 'pages': pages, 'resident': resident,
            'percent': 100 * resident / pages, 'details': details}
