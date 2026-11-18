import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { generateQrMatrix, renderQrSvg } from '../shared/qr.js';

function decodeQrMatrix(text) {
  const { size, modules, version, mask } = generateQrMatrix(text);
  const scale = 4;
  const margin = 4;
  const dim = (size + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4);

  for (let y = 0; y < dim; y += 1) {
    const mr = Math.floor(y / scale) - margin;
    for (let x = 0; x < dim; x += 1) {
      const mc = Math.floor(x / scale) - margin;
      const isDark = mr >= 0 && mr < size && mc >= 0 && mc < size && modules[mr][mc] === 1;
      const val = isDark ? 0 : 255;
      const idx = (y * dim + x) * 4;
      rgba[idx] = val;
      rgba[idx + 1] = val;
      rgba[idx + 2] = val;
      rgba[idx + 3] = 255;
    }
  }

  const decoded = jsQR(rgba, dim, dim);
  return { decoded, version, mask, size };
}

test('qr generator produces decodable QR codes across short, medium, and long URLs (v1-v14)', () => {
  const payloads = [
    'hi', // v1
    'https://a.io/#t=1', // v2
    'https://user.github.io/word_review/#token=ghp_1234567890abcdef1234567890abcdef&gist=abcdef1234567890', // v5-6
    'https://my-long-username.github.io/word_review/#token=github_pat_11ABCDEFG0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&gist=0123456789abcdef0123456789abcdef', // v7+
    'https://custom.domain.example.com/apps/word-review/#token=' + 'x'.repeat(120) + '&gist=' + 'a'.repeat(32), // v10+
    'https://example.com/' + 'a'.repeat(330), // v14 near max
    'https://example.com/#note=生词本测试UTF8', // UTF-8
  ];

  for (const text of payloads) {
    const { decoded, version } = decodeQrMatrix(text);
    assert.ok(decoded, `Failed to decode QR (v${version}) for payload length ${text.length}`);
    assert.equal(decoded.data, text, `Decoded mismatch at v${version}`);
  }
});

test('renderQrSvg produces valid crisp SVG markup', () => {
  const svg = renderQrSvg('https://example.com/#token=abc&gist=123');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<rect /);
  assert.match(svg, /<\/svg>$/);
});
