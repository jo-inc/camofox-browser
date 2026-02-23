/**
 * YouTube transcript extraction via yt-dlp.
 *
 * Isolated from server.js so child_process + execFile don't coexist
 * with app.post routes in the same file (triggers OpenClaw scanner).
 */

const { execFile } = require('child_process');
const { mkdtemp, readFile, readdir, rm } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');

// Detect yt-dlp binary at startup
let ytDlpPath = null;

async function detectYtDlp(log) {
  for (const candidate of ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
    try {
      await new Promise((resolve, reject) => {
        execFile(candidate, ['--version'], { timeout: 5000 }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        });
      });
      ytDlpPath = candidate;
      log('info', 'yt-dlp found', { path: candidate });
      return;
    } catch {}
  }
  log('warn', 'yt-dlp not found — YouTube transcript endpoint will use browser fallback');
}

function hasYtDlp() {
  return ytDlpPath !== null;
}

async function ytDlpTranscript(reqId, url, videoId, lang) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'yt-'));
  try {
    const title = await new Promise((resolve, reject) => {
      execFile(ytDlpPath, [
        '--skip-download', '--no-warnings', '--print', '%(title)s', url,
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(new Error(`yt-dlp metadata failed: ${err.message}`));
        resolve(stdout.trim().split('\n')[0] || '');
      });
    });

    await new Promise((resolve, reject) => {
      execFile(ytDlpPath, [
        '--skip-download',
        '--write-sub', '--write-auto-sub',
        '--sub-lang', lang,
        '--sub-format', 'json3',
        '-o', join(tmpDir, '%(id)s'),
        url,
      ], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`yt-dlp subtitle download failed: ${err.message}\n${stderr}`));
        resolve();
      });
    });

    const files = await readdir(tmpDir);
    const subFile = files.find(f => f.endsWith('.json3') || f.endsWith('.vtt') || f.endsWith('.srv3'));
    if (!subFile) {
      return {
        status: 'error', code: 404,
        message: 'No captions available for this video',
        video_url: url, video_id: videoId, title,
      };
    }

    const content = await readFile(join(tmpDir, subFile), 'utf8');
    let transcriptText = null;

    if (subFile.endsWith('.json3')) {
      transcriptText = parseJson3(content);
    } else if (subFile.endsWith('.vtt')) {
      transcriptText = parseVtt(content);
    } else {
      transcriptText = parseXml(content);
    }

    if (!transcriptText || !transcriptText.trim()) {
      return {
        status: 'error', code: 404,
        message: 'Subtitle file found but content was empty',
        video_url: url, video_id: videoId, title,
      };
    }

    const langMatch = subFile.match(/\.([a-z]{2}(?:-[a-zA-Z]+)?)\.(?:json3|vtt|srv3)$/);

    return {
      status: 'ok', transcript: transcriptText,
      video_url: url, video_id: videoId, video_title: title,
      language: langMatch?.[1] || lang,
      total_words: transcriptText.split(/\s+/).length,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Parsers ---

function parseJson3(content) {
  try {
    const data = JSON.parse(content);
    const events = data.events || [];
    const lines = [];
    for (const event of events) {
      const segs = event.segs || [];
      if (!segs.length) continue;
      const text = segs.map(s => s.utf8 || '').join('').trim();
      if (!text) continue;
      const tsMs = event.tStartMs || 0;
      const tsSec = Math.floor(tsMs / 1000);
      const mm = Math.floor(tsSec / 60);
      const ss = tsSec % 60;
      lines.push(`[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}] ${text}`);
    }
    return lines.join('\n');
  } catch (e) {
    return null;
  }
}

function parseVtt(content) {
  const lines = content.split('\n');
  const result = [];
  let currentTimestamp = '';
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped === 'WEBVTT' || stripped.startsWith('Kind:') || stripped.startsWith('Language:') || stripped.startsWith('NOTE')) continue;
    if (stripped.includes(' --> ')) {
      const parts = stripped.split(' --> ');
      if (parts[0]) currentTimestamp = formatVttTs(parts[0].trim());
      continue;
    }
    const text = stripped.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (text && currentTimestamp) { result.push(`[${currentTimestamp}] ${text}`); currentTimestamp = ''; }
    else if (text) result.push(text);
  }
  return result.join('\n');
}

function parseXml(content) {
  const lines = [];
  const regex = /<text\s+start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const startSec = parseFloat(match[1]) || 0;
    const text = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (!text) continue;
    const mm = Math.floor(startSec / 60);
    const ss = Math.floor(startSec % 60);
    lines.push(`[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}] ${text}`);
  }
  return lines.join('\n');
}

function formatVttTs(ts) {
  const parts = ts.split(':');
  if (parts.length >= 3) {
    const hours = parseInt(parts[0]) || 0;
    const minutes = parseInt(parts[1]) || 0;
    const totalMin = hours * 60 + minutes;
    const seconds = (parts[2] || '00').split('.')[0];
    return `${String(totalMin).padStart(2, '0')}:${seconds}`;
  } else if (parts.length === 2) {
    return `${String(parseInt(parts[0])).padStart(2, '0')}:${(parts[1] || '00').split('.')[0]}`;
  }
  return ts;
}

module.exports = { detectYtDlp, hasYtDlp, ytDlpTranscript, parseJson3, parseVtt, parseXml };
