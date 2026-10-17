#!/usr/bin/env python3
"""Build a UEFI-readable FAT32 Windows PE bootstrap from a UDF Windows ISO."""
import argparse, math, struct
from pathlib import Path, PurePosixPath

BLOCK = 2048


def udf_tree(image):
    data = image.read_bytes()
    # Locate the File Set Descriptor and physical UDF partition; Microsoft's
    # source ISO and derived images place these at different logical blocks.
    partition_start = None
    file_set = None
    for block in range(16, min(len(data) // BLOCK, 1024)):
        offset = block * BLOCK
        tag = struct.unpack_from('<H', data, offset)[0]
        if tag == 5 and partition_start is None:
            partition_start = struct.unpack_from('<I', data, offset + 188)[0]
        elif tag == 256 and file_set is None:
            file_set = offset
    if partition_start is None or file_set is None:
        raise ValueError('source does not contain a readable UDF partition and File Set Descriptor')
    def entry(logical):
        off = (partition_start + logical) * BLOCK
        d = data[off:off + BLOCK]
        if len(d) != BLOCK or struct.unpack_from('<H', d, 0)[0] != 261:
            raise ValueError(f'expected UDF file entry at logical block {logical}')
        size = struct.unpack_from('<Q', d, 56)[0]
        ea, adlen = struct.unpack_from('<II', d, 168)
        chunks = []
        for at in range(176 + ea, 176 + ea + adlen, 8):
            length, location = struct.unpack_from('<II', d, at)
            chunks.append((length, (partition_start + location) * BLOCK))
        return d[27] == 4, size, chunks
    def contents(chunks):
        return b''.join(data[offset:offset + length] for length, offset in chunks)
    files = {}
    def visit(logical, prefix):
        is_dir, size, chunks = entry(logical)
        if not is_dir:
            files[prefix] = contents(chunks)[:size]
            return
        directory = contents(chunks)[:size]
        at = 0
        while at + 38 <= len(directory) and struct.unpack_from('<H', directory, at)[0] == 257:
            _, flags, name_len = struct.unpack_from('<HBB', directory, at + 16)
            _, child, _ = struct.unpack_from('<IIH', directory, at + 20)
            impl_len = struct.unpack_from('<H', directory, at + 36)[0]
            encoded = directory[at + 38 + impl_len:at + 38 + impl_len + name_len]
            at = (at + 38 + impl_len + name_len + 3) & ~3
            if flags & 8: continue
            if not encoded: raise ValueError('empty UDF filename')
            if encoded[0] == 8:
                name = encoded[1:].decode('latin1')
            elif encoded[0] == 16:
                name = encoded[1:].decode('utf-16-be')
            else:
                raise ValueError(f'unsupported UDF filename encoding: {encoded[0]}')
            visit(child, prefix / name)
    # Root directory ICB is stored in the File Set Descriptor at byte 400.
    root = struct.unpack_from('<I', data, file_set + 404)[0]
    visit(root, PurePosixPath())
    return files

def short_name(name):
    name = name.upper()
    if name in ('.', '..'): return name.ljust(11).encode('ascii')
    stem, dot, ext = name.partition('.')
    allowed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%\'-_@~`!(){}^#&'
    if not stem or len(stem) > 8 or len(ext) > 3 or any(c not in allowed for c in stem + ext):
        # All included long names are unique in their directory; this standard
        # 8.3 alias is paired with a long-file-name entry below.
        stem = (stem[:6] + '~1')[:8]
        ext = ext[:3]
    return (stem.ljust(8) + ext.ljust(3)).encode('ascii')

def lfn_entries(name, alias):
    encoded = name.encode('utf-16le') + b'\0\0'
    units = [encoded[i:i + 2] for i in range(0, len(encoded), 2)]
    units += [b'\xff\xff'] * ((13 - len(units) % 13) % 13)
    chunks = [units[i:i + 13] for i in range(0, len(units), 13)]
    checksum = 0
    for value in alias: checksum = ((checksum & 1) << 7) + (checksum >> 1) + value & 0xff
    entries = []
    for index in range(len(chunks), 0, -1):
        e = bytearray(32); e[0] = index | (0x40 if index == len(chunks) else 0); e[11] = 0x0f; e[13] = checksum
        chunk = b''.join(chunks[index - 1]); e[1:11] = chunk[:10]; e[14:26] = chunk[10:22]; e[28:32] = chunk[22:26]
        entries.append(e)
    return entries

def build(output, files):
    # 1 GiB: Windows PE boot.wim plus complete EFI/BOOT trees fit with ample room.
    total_sectors, spc, reserved, fats = 2 * 1024 * 1024, 8, 32, 2
    fat_sectors = 1
    while True:
        clusters = (total_sectors - reserved - fats * fat_sectors) // spc
        next_size = math.ceil((clusters + 2) * 4 / 512)
        if next_size == fat_sectors: break
        fat_sectors = next_size
    paths = {PurePosixPath()}
    for p in files:
        paths.update(p.parents)
    dirs = sorted(paths, key=lambda p: (len(p.parts), str(p)))
    cluster = 2
    allocation = {}
    for d in dirs:
        allocation[d] = (cluster, 1); cluster += 1
    for p, content in sorted(files.items(), key=lambda x: str(x[0])):
        count = max(1, math.ceil(len(content) / (spc * 512)))
        allocation[p] = (cluster, count); cluster += count
    if cluster > clusters + 2: raise ValueError('bootstrap contents exceed image capacity')
    fat = [0] * (clusters + 2); fat[0] = 0x0ffffff8; fat[1] = 0x0fffffff
    for start, count in allocation.values():
        for n in range(count): fat[start + n] = 0x0fffffff if n == count - 1 else start + n + 1
    first_data = reserved + fats * fat_sectors
    def offset(c): return (first_data + (c - 2) * spc) * 512
    def directory(path):
        entries = bytearray()
        if path != PurePosixPath():
            parent = path.parent
            for name, target in (('.', path), ('..', parent)):
                e = bytearray(32); e[:11] = short_name(name); e[11] = 0x10
                struct.pack_into('<H', e, 20, allocation[target][0] >> 16); struct.pack_into('<H', e, 26, allocation[target][0] & 0xffff); entries += e
        children = sorted([p for p in allocation if p.parent == path and p != path], key=lambda x: x.name.upper())
        for child in children:
            start, count = allocation[child]; alias = short_name(child.name)
            if alias.rstrip().decode('ascii') != child.name.upper(): entries += b''.join(lfn_entries(child.name, alias))
            e = bytearray(32); e[:11] = alias; e[11] = 0x10 if child in paths else 0x20
            struct.pack_into('<H', e, 20, start >> 16); struct.pack_into('<H', e, 26, start & 0xffff)
            if child in files: struct.pack_into('<I', e, 28, len(files[child]))
            entries += e
        if len(entries) > spc * 512: raise ValueError(f'directory too large: {path}')
        return entries
    with output.open('wb') as f:
        f.truncate(total_sectors * 512)
        boot = bytearray(512); boot[:3] = b'\xebX\x90'; boot[3:11] = b'MSWIN4.1'; struct.pack_into('<H', boot, 11, 512); boot[13] = spc; struct.pack_into('<H', boot, 14, reserved); boot[16] = fats; struct.pack_into('<I', boot, 32, total_sectors); boot[21] = 0xf8; struct.pack_into('<I', boot, 36, fat_sectors); struct.pack_into('<I', boot, 44, 2); boot[510:512] = b'\x55\xaa'; f.write(boot)
        f.seek(6 * 512); fsinfo = bytearray(512); fsinfo[:4] = b'RRaA'; fsinfo[484:488] = b'rrAa'; struct.pack_into('<I', fsinfo, 488, clusters - (cluster - 2)); struct.pack_into('<I', fsinfo, 492, cluster); fsinfo[510:512] = b'\x55\xaa'; f.write(fsinfo)
        fat_bytes = struct.pack('<' + 'I' * len(fat), *fat)
        for n in range(fats): f.seek((reserved + n * fat_sectors) * 512); f.write(fat_bytes)
        for d in dirs: f.seek(offset(allocation[d][0])); f.write(directory(d))
        for p, content in files.items(): f.seek(offset(allocation[p][0])); f.write(content)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--source', type=Path, required=True); ap.add_argument('--output', type=Path, required=True); args = ap.parse_args()
    source = udf_tree(args.source)
    selected = {p: data for p, data in source.items() if str(p).lower().startswith(('efi/', 'boot/')) or str(p).lower() in ('bootmgr.efi', 'bootmgfw.efi', 'sources/boot.wim')}
    required = [PurePosixPath('efi/boot/bootaa64.efi'), PurePosixPath('efi/microsoft/boot/bcd'), PurePosixPath('sources/boot.wim')]
    if any(p not in selected for p in required): raise SystemExit('source ISO lacks required ARM64 Windows PE boot files')
    args.output.parent.mkdir(parents=True, exist_ok=True); build(args.output, selected)
    print(f'Created {args.output} with {len(selected)} files ({args.output.stat().st_size} bytes).')
if __name__ == '__main__': main()
