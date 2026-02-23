/**
 * YouTube transcript extraction via yt-dlp.
 *
 * Kept in a separate module so transcript process logic stays isolated.
 */

const childProcess = require('child_process');
const { mkdtemp, readFile, readdir, rm } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');

const runProgram = childProcess.execFile;

const YT_DLP_CANDIDATES = ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'];
const LANG_RE = /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;

// Detect yt-dlp binary at startup
let ytDlpPath = null;

function buildSafeEnv() {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function normalizeYoutubeUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) {
    throw new Error('Missing video URL');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid video URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported URL scheme');
  }

  const host = parsed.hostname.toLowerCase();
  const isYoutubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
  const isShortHost = host === 'youtu.be';
  if (!isYoutubeHost && !isShortHost) {
    throw new Error('Only YouTube URLs are allowed');
  }

  return parsed.toString();
}

function normalizeLanguage(rawLang) {
  const lang = String(rawLang || 'en').trim();
  if (!LANG_RE.test(lang)) {
    return 'en';
  }
  return lang;
}

async function runYtDlp(binary, args, timeoutMs) {
  return await new Promise((resolve, reject) => {
    runProgram(
      binary,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: buildSafeEnv(),
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout = '', stderr = '') => {
        if (err) {
          return reject(new Error(`${err.message}\n${String(stderr).trim()}`.trim()));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function detectYtDlp(log) {
  for (const candidate of YT_DLP_CANDIDATES) {
    try {
      await runYtDlp(candidate, ['--version'], 5000);
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
  if (!ytDlpPath) {
    throw new Error('yt-dlp is not available');
  }

  const normalizedUrl = normalizeYoutubeUrl(url);
  const normalizedLang = normalizeLanguage(lang);
  const tmpDir = await mkdtemp(join(tmpdir(), 'yt-'));

  try {
    const titleResult = await runYtDlp(
      ytDlpPath,
      ['--skip-download', '--no-warnings', '--print', '%(title)s', normalizedUrl],
      15000,
    );
    const title = titleResult.stdout.trim().split('\n')[0] || '';

    await runYtDlp(
      ytDlpPath,
      [
        '--skip-download',
        '--write-sub',
        '--write-auto-sub',
        '--sub-lang',
        normalizedLang,
        '--sub-format',
        'json3',
        '-o',
        join(tmpDir, '%(id)s'),
        normalizedUrl,
      ],
      30000,
    );

    const files = await readdir(tmpDir);
    const subFile = files.find((f) => f.endsWith('.json3') || f.endsWith('.vtt') || f.endsWith('.srv3'));
    if (!subFile) {
      return {
        status: 'error',
        code: 404,
        message: 'No captions available for this video',
        video_url: normalizedUrl,
        video_id: videoId,
        title,
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
        status: 'error',
        code: 404,
        message: 'Subtitle file found but content was empty',
        video_url: normalizedUrl,
        video_id: videoId,
        title,
      };
    }

    const langMatch = subFile.match(/\.([a-z]{2}(?:-[a-zA-Z]+)?)\.(?:json3|vtt|srv3)$/);

    return {
      status: 'ok',
      transcript: transcriptText,
      video_url: normalizedUrl,
      video_id: videoId,
      video_title: title,
      language: langMatch?.[1] || normalizedLang,
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
      const text = segs
        .map((s) => s.utf8 || '')
        .join('')
        .trim();
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
    if (
      !stripped ||
      stripped === 'WEBVTT' ||
      stripped.startsWith('Kind:') ||
      stripped.startsWith('Language:') ||
      stripped.startsWith('NOTE')
    )
      continue;
    if (stripped.includes(' --> ')) {
      const parts = stripped.split(' --> ');
      if (parts[0]) currentTimestamp = formatVttTs(parts[0].trim());
      continue;
    }
    const text = stripped
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (text && currentTimestamp) {
      result.push(`[${currentTimestamp}] ${text}`);
      currentTimestamp = '';
    } else if (text) result.push(text);
  }
  return result.join('\n');
}

function parseXml(content) {
  const lines = [];
  const regex = /<text\s+start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
  for (const match of content.matchAll(regex)) {
    const startSec = parseFloat(match[1]) || 0;
    const text = match[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
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
