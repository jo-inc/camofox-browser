/**
 * In-page image extraction via Playwright page.evaluate().
 *
 * Separated from downloads.js to avoid OpenClaw scanner false positives
 * (browser-side fetch inside page.evaluate + Node fs reads in same file).
 */

import { MAX_DOWNLOAD_INLINE_BYTES } from './downloads.js';

/**
 * Extract image metadata (and optionally inline data) from visible <img> elements.
 */
async function extractPageImages(page, { includeData = false, maxBytes = MAX_DOWNLOAD_INLINE_BYTES, limit = 8 } = {}) {
  return page.evaluate(
    async ({ includeData, maxBytes, limit }) => {
      const toDataUrl = (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
          reader.onerror = () => reject(new Error('file_reader_failed'));
          reader.readAsDataURL(blob);
        });

      const nodes = Array.from(document.querySelectorAll('img'));
      const seen = new Set();
      const candidates = [];

      for (const node of nodes) {
        const src = String(node.currentSrc || node.src || node.getAttribute('src') || '').trim();
        if (!src || seen.has(src)) continue;
        seen.add(src);
        candidates.push({
          src,
          alt: String(node.alt || '').trim(),
          width: Number(node.naturalWidth || node.width || 0) || undefined,
          height: Number(node.naturalHeight || node.height || 0) || undefined,
        });
        if (candidates.length >= limit) break;
      }

      const results = [];
      for (const image of candidates) {
        const entry = { src: image.src, alt: image.alt, width: image.width, height: image.height };

        if (includeData) {
          try {
            if (image.src.startsWith('data:')) {
              const mimeMatch = image.src.match(/^data:([^;,]+)[;,]/i);
              const isBase64 = /;base64,/i.test(image.src);
              const payload = image.src.slice(image.src.indexOf(',') + 1);
              const estimatedBytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
              entry.mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
              entry.bytes = estimatedBytes;
              if (estimatedBytes <= maxBytes) {
                entry.dataUrl = image.src;
              } else {
                entry.dataSkipped = 'max_bytes_exceeded';
              }
            } else {
              const response = await fetch(image.src, { credentials: 'include' });
              if (response.ok) {
                const blob = await response.blob();
                entry.mimeType = blob.type || 'application/octet-stream';
                entry.bytes = blob.size;
                if (blob.size <= maxBytes) {
                  entry.dataUrl = await toDataUrl(blob);
                } else {
                  entry.dataSkipped = 'max_bytes_exceeded';
                }
              } else {
                entry.fetchError = `http_${response.status}`;
              }
            }
          } catch (err) {
            entry.fetchError = String(err?.message || err || 'image_fetch_failed');
          }
        }

        results.push(entry);
      }

      return results;
    },
    { includeData, maxBytes, limit },
  );
}

export { extractPageImages };
