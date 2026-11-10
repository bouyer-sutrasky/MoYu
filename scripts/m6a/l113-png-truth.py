#!/usr/bin/env python3
"""Independent ground truth for the L113 screenshot: dimensions and sampled pixels.

Reads a non-interlaced 8-bit RGB PNG with zlib only (no Pillow), so the evidence does
not depend on an image library being installed. Usage: l113-png-truth.py <png>
"""
import struct
import sys
import zlib


def decode(path: str):
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('not a PNG')
    pos, idat, width, height, bit, color = 8, b'', None, None, None, None
    while pos < len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        pos += 8
        chunk = data[pos:pos + length]
        pos += length + 4
        if kind == b'IHDR':
            width, height, bit, color, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
            if bit != 8 or color != 2 or interlace != 0:
                raise SystemExit('expects 8-bit RGB, non-interlaced')
        elif kind == b'IDAT':
            idat += chunk
        elif kind == b'IEND':
            break
    raw = zlib.decompress(idat)
    stride = width * 3
    rows, previous, index = [], bytearray(stride), 0
    for _ in range(height):
        filt = raw[index]
        index += 1
        line = bytearray(raw[index:index + stride])
        index += stride
        if filt == 1:
            for x in range(3, stride):
                line[x] = (line[x] + line[x - 3]) & 255
        elif filt == 2:
            for x in range(stride):
                line[x] = (line[x] + previous[x]) & 255
        elif filt == 3:
            for x in range(stride):
                left = line[x - 3] if x >= 3 else 0
                line[x] = (line[x] + ((left + previous[x]) >> 1)) & 255
        elif filt == 4:
            for x in range(stride):
                left = line[x - 3] if x >= 3 else 0
                up = previous[x]
                upleft = previous[x - 3] if x >= 3 else 0
                estimate = left + up - upleft
                pa, pb, pc = abs(estimate - left), abs(estimate - up), abs(estimate - upleft)
                predictor = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
                line[x] = (line[x] + predictor) & 255
        elif filt != 0:
            raise SystemExit(f'unknown filter {filt}')
        rows.append(bytes(line))
        previous = line
    return width, height, rows


def main() -> None:
    width, height, rows = decode(sys.argv[1])
    print('dimensions:', width, height)
    for name, (x, y) in {
        'red_rect_center': (160, 565),
        'blue_circle_center': (380, 565),
        'background': (20, 20),
    }.items():
        r, g, b = rows[y][x * 3:x * 3 + 3]
        print(f'{name}: RGB({r}, {g}, {b}) #{r:02X}{g:02X}{b:02X}')


if __name__ == '__main__':
    main()
