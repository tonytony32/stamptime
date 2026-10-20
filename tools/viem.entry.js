// The parts of viem the page uses, bundled into public/vendor/viem.js so the page reads Gnosis with no build step and
// no third party script. Same viem version as Batch Explorer. A bare client and the three actions the page calls,
// rather than createPublicClient, which brings every action along. To regenerate, from this folder:
//
//   npm install --no-save --no-package-lock viem@2.47.6 esbuild@0.25.12
//   npx esbuild viem.entry.js --bundle --format=esm --minify --legal-comments=eof --outfile=../public/vendor/viem.js \
//     --banner:js="/*! viem 2.47.6 (tools/viem.entry.js, generated: do not edit). MIT License: viem and abitype, Copyright (c) 2022-present weth, LLC; ox, Copyright (c) 2023-present wevm; @noble/hashes and @noble/curves, Copyright (c) 2022 Paul Miller. */"
//
export { createClient, decodeEventLog, getAddress, http, numberToHex } from 'viem';
export { getBlock, getTransaction, readContract } from 'viem/actions';
