"""Generate js/keydata.js from upstream ha-ef-ble keydata.py (Apache-2.0).
Usage: python3 -I tools/make-keydata.py <path/to/keydata.py> <out.js>"""
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'b64decode\(\s*b"\\\n(.*?)"\s*\)', src, re.S)
b64 = re.sub(r'\\\n', '', m.group(1)).replace('\n', '')
import base64
raw = base64.b64decode(b64)
open(sys.argv[2], 'w').write(
    '// Session-key lookup table, from rabits/ha-ef-ble (Apache-2.0). See NOTICE.\n'
    f'// {len(raw)} bytes.\n'
    'const B64 = "' + b64 + '";\n'
    'const bin = atob(B64);\n'
    'export const KEYDATA = Uint8Array.from(bin, (c) => c.charCodeAt(0));\n'
    'export const get8bytes = (pos) => KEYDATA.subarray(pos, pos + 8);\n')
print(len(raw), 'bytes')
