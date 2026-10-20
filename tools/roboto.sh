#!/bin/sh
# Roboto for the page, served from public/fonts/ instead of Google Fonts: one woff2 for the three weights the page uses,
# cut to the characters it can show. 25.1 KB, where Google Fonts sent three files, 90.5 KB, after a render blocking
# stylesheet from another origin (the arrows' "symbols" file among them, though Roboto has no arrows).
#
#   - the variable font from google/fonts (ofl/roboto/Roboto[wdth,wght].ttf, version 3.015, sha256 below), with its width
#     fixed at 100 and its weight kept from 400 to 700: the page uses 400, 500 and 700
#   - Basic Latin and Latin-1, and the few marks the page writes: dashes, quotes, bullet, ellipsis, euro, trade mark,
#     minus and the ≈ of Adding time. The arrows fall back to the system font, as they did with Google Fonts
#   - kerning, ligatures and tabular figures (font-variant-numeric: tabular-nums), and TrueType hinting, which Google
#     Fonts sends to Windows
#
# Needs fonttools and brotli (pip install fonttools brotli). From this folder:
#
#   curl -L -o Roboto.ttf 'https://github.com/google/fonts/raw/main/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf'
#   sh roboto.sh Roboto.ttf
#
# Roboto is under the SIL Open Font License 1.1, public/fonts/OFL.txt.
set -e
src=${1:?usage: sh roboto.sh Roboto.ttf}
echo "d7598e12c5dbef095ff8272cfc55da0250bd07fbdecbac8a530b9b277872a134  $src" | shasum -a 256 -c -   # the file used
fonttools varLib.instancer "$src" wdth=100 wght=400:700 -o roboto-instance.ttf
pyftsubset roboto-instance.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+2039-203A,U+20AC,U+2122,U+2212,U+2248" \
  --layout-features="kern,liga,calt,ccmp,locl,mark,mkmk,tnum" --hinting --name-IDs="*" --notdef-outline \
  --flavor=woff2 --output-file=../public/fonts/roboto.woff2
rm roboto-instance.ttf
