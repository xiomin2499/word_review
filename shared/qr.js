/**
 * Zero-dependency ISO/IEC 18004 QR Code SVG/matrix generator (Byte mode, ECC Level M, Versions 1-14).
 * Canonical source: shared/qr.js
 */

// [version]: [ecPerBlock, [[group1Count, group1DataCw], [group2Count, group2DataCw]?], alignmentCoords]
const QR_VERSIONS_M = {
  1: [10, [[1, 16]], []],
  2: [16, [[1, 28]], [6, 18]],
  3: [26, [[1, 44]], [6, 22]],
  4: [18, [[2, 32]], [6, 26]],
  5: [24, [[2, 43]], [6, 30]],
  6: [16, [[4, 27]], [6, 34]],
  7: [18, [[4, 31]], [6, 22, 38]],
  8: [22, [[2, 38], [2, 39]], [6, 24, 42]],
  9: [22, [[3, 36], [2, 37]], [6, 26, 46]],
  10: [26, [[4, 43], [1, 44]], [6, 28, 50]],
  11: [30, [[1, 50], [4, 51]], [6, 30, 54]],
  12: [22, [[6, 36], [2, 37]], [6, 32, 58]],
  13: [22, [[8, 37], [1, 38]], [6, 34, 62]],
  14: [24, [[4, 40], [5, 41]], [6, 26, 46, 66]],
};

// GF(256) with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function polyMul(p, q) {
  const res = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i += 1) {
    for (let j = 0; j < q.length; j += 1) {
      res[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return res;
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    poly = polyMul(poly, new Uint8Array([1, GF_EXP[i]]));
  }
  return poly;
}

function rsComputeEcc(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const factor = res[i];
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j += 1) {
        res[i + j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return res.slice(data.length);
}

function computeFormatBits(maskPattern) {
  // ECC Level M = 0b00, 3-bit maskPattern => 5-bit data
  const data = (0b00 << 3) | (maskPattern & 0b111);
  let rem = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >> i) & 1) {
      rem ^= poly << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function computeVersionBits(version) {
  let rem = version << 12;
  const poly = 0b1111100100101;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >> i) & 1) {
      rem ^= poly << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function pickVersion(byteLength) {
  for (let v = 1; v <= 14; v += 1) {
    const [, groups] = QR_VERSIONS_M[v];
    const totalDataCw = groups.reduce((sum, [cnt, cw]) => sum + cnt * cw, 0);
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    const capacityBytes = Math.floor((totalDataCw * 8 - headerBits) / 8);
    if (byteLength <= capacityBytes) {
      return { version: v, totalDataCw };
    }
  }
  throw new Error(`QR payload too long (${byteLength} bytes, max 362 bytes)`);
}

function encodeDataCodewords(bytes, version, totalDataCw) {
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) {
    pushBits(b, 8);
  }

  const maxBits = totalDataCw * 8;
  const terminator = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) {
      byte = (byte << 1) | bits[i + j];
    }
    codewords.push(byte);
  }

  const pads = [0xec, 0x11];
  let p = 0;
  while (codewords.length < totalDataCw) {
    codewords.push(pads[p % 2]);
    p += 1;
  }

  return codewords;
}

function buildFinalCodewords(dataCodewords, version) {
  const [ecPerBlock, groups] = QR_VERSIONS_M[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (const [count, cwCount] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = Uint8Array.from(dataCodewords.slice(offset, offset + cwCount));
      offset += cwCount;
      dataBlocks.push(block);
      ecBlocks.push(rsComputeEcc(block, ecPerBlock));
    }
  }

  const result = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      result.push(block[i]);
    }
  }
  return result;
}

function createBaseMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunc[r][c] = 1;
  };

  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const isCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inOuter && (isBorder || isCore));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  const coords = QR_VERSIONS_M[version][2];
  for (const cr of coords) {
    for (const cc of coords) {
      if (isFunc[cr][cc]) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist === 0 || dist === 2);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    if (!isFunc[6][i]) setFunc(6, i, i % 2 === 0);
    if (!isFunc[i][6]) setFunc(i, 6, i % 2 === 0);
  }

  // Dark module
  setFunc(size - 8, 8, true);

  // Reserve format info zones
  for (let i = 0; i <= 8; i += 1) {
    if (!isFunc[8][i]) setFunc(8, i, false);
    if (!isFunc[i][8]) setFunc(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!isFunc[8][size - 1 - i]) setFunc(8, size - 1 - i, false);
  }
  for (let i = 0; i < 7; i += 1) {
    if (!isFunc[size - 1 - i][8]) setFunc(size - 1 - i, 8, false);
  }

  // Version info (version >= 7)
  if (version >= 7) {
    const vBits = computeVersionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = Boolean((vBits >> i) & 1);
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setFunc(r, c, dark);
      setFunc(c, r, dark);
    }
  }

  return { size, modules, isFunc };
}

function placeDataBits(base, finalCodewords) {
  const { size, modules, isFunc } = base;
  const totalBits = finalCodewords.length * 8;
  let bitIdx = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx;
        if (isFunc[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          const byteVal = finalCodewords[bitIdx >> 3];
          bit = (byteVal >> (7 - (bitIdx & 7))) & 1;
        }
        modules[r][c] = bit;
        bitIdx += 1;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function writeFormatInfo(modules, size, mask) {
  const fmt = computeFormatBits(mask);
  for (let i = 0; i <= 5; i += 1) modules[8][i] = (fmt >> (14 - i)) & 1;
  modules[8][7] = (fmt >> 8) & 1;
  modules[8][8] = (fmt >> 7) & 1;
  modules[7][8] = (fmt >> 6) & 1;
  for (let i = 9; i < 15; i += 1) modules[14 - i][8] = (fmt >> (14 - i)) & 1;

  for (let i = 0; i < 7; i += 1) modules[size - 1 - i][8] = (fmt >> (14 - i)) & 1;
  for (let i = 7; i < 15; i += 1) modules[8][size - 15 + i] = (fmt >> (14 - i)) & 1;
}

function penaltyScore(modules, size) {
  let score = 0;

  // Rule 1: 5+ adjacent modules of same color in row or col
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like pattern
  const matchPattern = (arr, start) => {
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    let m1 = true;
    let m2 = true;
    for (let k = 0; k < 11; k += 1) {
      if (arr[start + k] !== p1[k]) m1 = false;
      if (arr[start + k] !== p2[k]) m2 = false;
    }
    return m1 || m2;
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c <= size - 11; c += 1) {
      if (matchPattern(modules[r], c)) score += 40;
    }
  }
  const col = new Uint8Array(size);
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r < size; r += 1) col[r] = modules[r][c];
    for (let r = 0; r <= size - 11; r += 1) {
      if (matchPattern(col, r)) score += 40;
    }
  }

  // Rule 4: dark ratio
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) darkCount += 1;
    }
  }
  const pct = (darkCount * 100) / (size * size);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  score += k * 10;

  return score;
}

export function generateQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const { version, totalDataCw } = pickVersion(bytes.length);
  const dataCodewords = encodeDataCodewords(bytes, version, totalDataCw);
  const finalCodewords = buildFinalCodewords(dataCodewords, version);

  const base = createBaseMatrix(version);
  placeDataBits(base, finalCodewords);

  const { size, modules, isFunc } = base;
  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => Uint8Array.from(row));
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!isFunc[r][c] && maskBit(mask, r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    writeFormatInfo(candidate, size, mask);
    const score = penaltyScore(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  return {
    version,
    mask: bestMask,
    size,
    modules: bestMatrix,
  };
}

export function renderQrSvg(text, { margin = 3, darkColor = '#111827', lightColor = '#ffffff' } = {}) {
  const { size, modules } = generateQrMatrix(text);
  const total = size + margin * 2;
  const rects = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) {
        rects.push(`<rect x="${c + margin}" y="${r + margin}" width="1" height="1"/>`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${lightColor}"/>` +
    `<g fill="${darkColor}">${rects.join('')}</g>` +
    `</svg>`
  );
}
