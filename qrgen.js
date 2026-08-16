/**
 * 极简 QR Code 生成器 —— 零 npm 依赖（仅用 Node 内置 zlib）。
 * 支持：字节模式 / 纠错等级 L / 版本 1-9 / PNG 输出。
 * 算法参考 ISO/IEC 18004 与 qrcode-generator 的公开实现。
 */
import zlib from "node:zlib";

// ── GF(256) 表（primitive 0x11d） ─────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// ── RS 块表（纠错 L）：[版本] = [块数, 每块总码字, 每块数据码字] ──
const RS_L = [
  null,
  [1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80], [1, 134, 108],
  [2, 86, 68], [2, 98, 78], [2, 121, 97], [2, 146, 116],
];

// 生成 n 个纠错码字的多项式系数（最高次在前）
const genPolyCache = {};
function rsGenPoly(n) {
  if (genPolyCache[n]) return genPolyCache[n];
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  genPolyCache[n] = poly;
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen); // 升序（常数项在前）
  const genRev = gen.slice().reverse(); // 降序（最高次在前，长除法对齐用）
  const res = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const f = res[i];
    if (f !== 0) {
      for (let j = 0; j < genRev.length; j++) res[i + j] ^= gmul(genRev[j], f);
    }
  }
  return res.slice(data.length);
}

// ── 格式信息 / 版本信息（BCH） ────────────────────────────────
function formatBits(ecl, mask) {
  let d = (ecl << 3) | mask;
  let rem = d;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return (((d << 10) | rem) ^ 0x5412) & 0x7fff;
}

function versionBits(v) {
  // BCH(18,6)：版本号 6 位 → 18 位码字；生成多项式 0x1f25（13 位）
  let dd = v << 12;
  for (let i = 17; i >= 12; i--) {
    if ((dd >>> i) & 1) dd ^= 0x1f25 << (i - 12);
  }
  return (v << 12) | (dd & 0xfff);
}

// ── 对齐图案位置表（v1-9） ───────────────────────────────────
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];

function makeMatrix(version) {
  const size = 17 + version * 4;
  const m = [];
  for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));

  // Finder + separator
  const putFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        m[rr][cc] = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      }
    }
  };
  putFinder(0, 0);
  putFinder(0, size - 7);
  putFinder(size - 7, 0);

  // Alignment patterns
  const aligns = ALIGN[version];
  for (const r of aligns) {
    for (const c of aligns) {
      if (m[r][c] !== null) continue; // 跳过与 finder 重叠
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = on;
        }
      }
    }
  }

  // Timing
  for (let i = 8; i < size - 8; i++) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
  }

  // Dark module
  m[size - 8][8] = true;

  // 格式信息
  const putFormat = (bits) => {
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >> i) & 1) === 1;
      if (i < 6) m[i][8] = mod;
      else if (i < 8) m[i + 1][8] = mod;
      else m[size - 15 + i][8] = mod;
      if (i < 8) m[8][size - i - 1] = mod;
      else if (i < 9) m[8][15 - i - 1 + 1] = mod;
      else m[8][15 - i - 1] = mod;
    }
  };
  const eclBits = 1; // L
  putFormat(formatBits(eclBits, 0));

  // 版本信息（v≥7）
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const mod = ((bits >> i) & 1) === 1;
      m[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = mod;
      m[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }
  return m;
}

// ── 数据放置 + 掩码 ──────────────────────────────────────────
function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
  return false;
}

function placeData(m, data, mask) {
  const size = m.length;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] === null) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          m[row][col - c] = dark !== maskBit(mask, row, col - c);
          bitIndex--;
          if (bitIndex < 0) {
            bitIndex = 7;
            byteIndex++;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

// ── 罚分 ─────────────────────────────────────────────────────
function lostPoint(m) {
  const size = m.length;
  let lost = 0;
  // 规则 1：同行/列连续同色 ≥5
  for (let row = 0; row < size; row++) {
    let same = 1;
    for (let col = 1; col < size; col++) {
      if (m[row][col] === m[row][col - 1]) {
        same++;
        if (col === size - 1 && same >= 5) lost += 3 + (same - 5);
      } else {
        if (same >= 5) lost += 3 + (same - 5);
        same = 1;
      }
    }
  }
  for (let col = 0; col < size; col++) {
    let same = 1;
    for (let row = 1; row < size; row++) {
      if (m[row][col] === m[row - 1][col]) {
        same++;
        if (row === size - 1 && same >= 5) lost += 3 + (same - 5);
      } else {
        if (same >= 5) lost += 3 + (same - 5);
        same = 1;
      }
    }
  }
  // 规则 2：2x2 同色块
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const v = m[row][col];
      if (v === m[row][col + 1] && v === m[row + 1][col] && v === m[row + 1][col + 1]) lost += 3;
    }
  }
  // 规则 3：1011101 前后 4 白
  const PAT = [1, 0, 1, 1, 1, 0, 1];
  const checkRun = (arr) => {
    let p = 0;
    for (let i = 0; i + 7 <= arr.length; i++) {
      let match = true;
      for (let k = 0; k < 7; k++) {
        if (arr[i + k] !== PAT[k]) { match = false; break; }
      }
      if (match && ((i >= 4 && arr[i - 4] === 0 && arr[i - 3] === 0 && arr[i - 2] === 0 && arr[i - 1] === 0) ||
                    (i + 11 <= arr.length && arr[i + 7] === 0 && arr[i + 8] === 0 && arr[i + 9] === 0 && arr[i + 10] === 0))) {
        p += 40;
      }
    }
    return p;
  };
  for (let row = 0; row < size; row++) {
    const arr = m[row].map((v) => (v ? 1 : 0));
    lost += checkRun(arr);
  }
  for (let col = 0; col < size; col++) {
    const arr = [];
    for (let row = 0; row < size; row++) arr.push(m[row][col] ? 1 : 0);
    lost += checkRun(arr);
  }
  // 规则 4：黑白比例
  let dark = 0;
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (m[row][col]) dark++;
  const total = size * size;
  const ratio = (dark * 100) / total;
  lost += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return lost;
}

// ── 主入口 ───────────────────────────────────────────────────
/**
 * 生成二维码 PNG。
 * @param {string} text 内容（字节模式）
 * @param {{scale?: number, margin?: number}} [opts]
 * @returns {Buffer} PNG buffer；内容过长返回 null
 */
export function qrToPng(text, opts = {}) {
  const scale = opts.scale ?? 4;
  const margin = opts.margin ?? 4;
  const forceMask = opts.forceMask ?? null;
  const bytes = Buffer.from(String(text), "utf8");
  const n = bytes.length;

  // 选版本（纠错 L，字节模式，v1-9）
  let version = null;
  for (let v = 1; v <= 9; v++) {
    const [numBlocks, , dataCodewords] = RS_L[v];
    const bits = 4 + 8 + n * 8 + 4; // mode + count + data + terminator
    if (bits <= dataCodewords * numBlocks * 8) { version = v; break; }
  }
  if (!version) return null;

  // 数据码字
  const dataBits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) dataBits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // 字节模式
  pushBits(n, 8); // 字符数（v1-9 为 8 bit）
  for (const b of bytes) pushBits(b, 8);
  const [, totalPerBlock, dataPerBlock] = RS_L[version];
  const dataCodewordsTotal = RS_L[version][2] * RS_L[version][0];
  const capacityBits = dataCodewordsTotal * 8;
  // terminator（最多 4 位 0）
  if (dataBits.length + 4 <= capacityBits) pushBits(0, 4);
  else pushBits(0, capacityBits - dataBits.length);
  // 对齐到字节边界
  while (dataBits.length % 8 !== 0) pushBits(0, 1);
  // 交替填充 0xEC / 0x11
  let padByte = 0xec;
  while (dataBits.length < capacityBits) {
    pushBits(padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }
  const dataCodewords = [];
  for (let i = 0; i < dataBits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | dataBits[i + j];
    dataCodewords.push(v);
  }

  // RS 分块 + 交织
  const numBlocks = RS_L[version][0];
  const ecLen = totalPerBlock - dataPerBlock;
  const blocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const data = dataCodewords.slice(b * dataPerBlock, (b + 1) * dataPerBlock);
    blocks.push({ data, ec: rsEncode(data, ecLen) });
  }
  const final = [];
  for (let i = 0; i < dataPerBlock; i++) {
    for (const blk of blocks) if (i < blk.data.length) final.push(blk.data[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of blocks) final.push(blk.ec[i]);
  }

  // 选掩码
  let best = null;
  let bestLost = Infinity;
  const masks = forceMask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  for (const mask of masks) {
    const m = makeMatrix(version);
    // 重放格式信息（含当前掩码）
    const size = m.length;
    const putFormat = (bits) => {
      for (let i = 0; i < 15; i++) {
        const mod = ((bits >> i) & 1) === 1;
        if (i < 6) m[i][8] = mod;
        else if (i < 8) m[i + 1][8] = mod;
        else m[size - 15 + i][8] = mod;
        if (i < 8) m[8][size - i - 1] = mod;
        else if (i < 9) m[8][15 - i - 1 + 1] = mod;
        else m[8][15 - i - 1] = mod;
      }
    };
    putFormat(formatBits(1, mask));
    placeData(m, final, mask);
    const lp = lostPoint(m);
    if (lp < bestLost) {
      bestLost = lp;
      best = { m, mask };
    }
  }

  // 最终矩阵：用最佳掩码重做一次（功能图案由 makeMatrix 提供，格式信息覆盖）
  const m = makeMatrix(version);
  const size = m.length;
  const putFormatFinal = (bits) => {
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >> i) & 1) === 1;
      if (i < 6) m[i][8] = mod;
      else if (i < 8) m[i + 1][8] = mod;
      else m[size - 15 + i][8] = mod;
      if (i < 8) m[8][size - i - 1] = mod;
      else if (i < 9) m[8][15 - i - 1 + 1] = mod;
      else m[8][15 - i - 1] = mod;
    }
  };
  putFormatFinal(formatBits(1, best.mask));
  placeData(m, final, best.mask);

  return pngEncode(m, scale, margin);
}

// ── PNG 编码 ─────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function pngEncode(matrix, scale, margin) {
  const w = matrix.length;
  const dw = w * scale + margin * 2 * scale;
  const dh = dw;
  const raw = Buffer.alloc(dh * (1 + dw));
  for (let y = 0; y < dh; y++) {
    const rowOff = y * (1 + dw);
    raw[rowOff] = 0; // filter none
    const my = Math.floor((y - margin * scale) / scale);
    for (let x = 0; x < dw; x++) {
      const mx = Math.floor((x - margin * scale) / scale);
      const on = mx >= 0 && mx < w && my >= 0 && my < w && matrix[my][mx] === true;
      raw[rowOff + 1 + x] = on ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dw, 0);
  ihdr.writeUInt32BE(dh, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
