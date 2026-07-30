/**
 * YouTube transcript plugin.
 *
 * Extracts video transcripts via yt-dlp (preferred) with browser fallback.
 * Registers POST /youtube/transcript.
 */

import { detectYtDlp, hasYtDlp, ensureYtDlp, ytDlpTranscript, parseJson3, parseVtt, parseXml } from './youtube.js';
import { classifyError } from '../../lib/request-utils.js';

export async function register(app, ctx, pluginConfig = {}) {
  const { log, config, ensureBrowser, getSession,
          destroySessionCoordinated, enterInternalSessionOperation,
          withUserLimit, safePageClose,
          validateUrl, safeError, buildProxyUrl, proxyPool,
          failuresTotal } = ctx;

  const NAVIGATE_TIMEOUT_MS = config.navigateTimeoutMs;

  // Detect yt-dlp binary at load time
  await detectYtDlp(log);

  // Auth is on by default; set { "auth": false } in camofox.config.json to disable
  // Auth off by default -- matches pre-plugin behavior. Set { "auth": true } to require auth.
  const middleware = pluginConfig.auth === true ? ctx.auth() : (_req, _res, next) => next();

  /**
   * @openapi
   * /youtube/transcript:
   *   post:
   *     tags: [Content]
   *     summary: Extract a YouTube transcript
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [url]
   *             properties:
   *               url: { type: string, format: uri }
   *               languages:
   *                 type: array
   *                 items: { type: string }
   *     responses:
   *       200:
   *         description: Transcript extraction result.
   *       400:
   *         description: Invalid input URL.
   *       500:
   *         description: Transcript extraction failed.
   */
  app.post('/youtube/transcript', middleware, async (req, res) => {
    const reqId = req.reqId;
    try {
      const { url, languages = ['en'] } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });

      const urlErr = validateUrl(url);
      if (urlErr) return res.status(400).json({ error: urlErr });

      const videoIdMatch = url.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
      );
      if (!videoIdMatch) {
        return res.status(400).json({ error: 'Could not extract YouTube video ID from URL' });
      }
      const videoId = videoIdMatch[1];
      const lang = languages[0] || 'en';

      // Re-detect yt-dlp if startup detection failed (transient issue)
      await ensureYtDlp(log);

      const ytDlpProxyUrl = buildProxyUrl(proxyPool, config.proxy);
      log('info', 'youtube transcript: starting', { reqId, videoId, lang, method: hasYtDlp() ? 'yt-dlp' : 'browser', hasProxy: !!ytDlpProxyUrl });

      let result;
      if (hasYtDlp()) {
        try {
          result = await ytDlpTranscript(reqId, url, videoId, lang, ytDlpProxyUrl);
        } catch (ytErr) {
          log('warn', 'yt-dlp threw, falling back to browser', { reqId, error: ytErr.message });
          result = null;
        }
        // If yt-dlp returned an error result (e.g. no captions) or threw, try browser
        if (!result || result.status !== 'ok') {
          if (result) log('warn', 'yt-dlp returned error, falling back to browser', { reqId, status: result.status, code: result.code });
          result = await browserTranscript(reqId, url, videoId, lang);
        }
      } else {
        result = await browserTranscript(reqId, url, videoId, lang);
      }

      log('info', 'youtube transcript: done', { reqId, videoId, status: result.status, words: result.total_words });
      res.json(result);
    } catch (err) {
      failuresTotal.labels(classifyError(err), 'youtube_transcript').inc();
      log('error', 'youtube transcript failed', { reqId, error: err.message, stack: err.stack });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // Browser fallback -- play video, intercept timedtext network response
  async function browserTranscript(reqId, url, videoId, lang) {
    return await withUserLimit('__yt_transcript__', async () => {
      const ytKey = '__yt_transcript__';
      const finishOperation = enterInternalSessionOperation(ytKey);
      let session = null;
      let page = null;
      try {
        await ensureBrowser();
        session = await getSession(ytKey);
        page = await session.context.newPage();
        await page.addInitScript(() => {
          const origPlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function() { this.volume = 0; this.muted = true; return origPlay.call(this); };
        });

        let interceptedCaptions = null;
        page.on('response', async (response) => {
          const respUrl = response.url();
          if (respUrl.includes('/api/timedtext') && respUrl.includes(`v=${videoId}`) && !interceptedCaptions) {
            try {
              const body = await response.text();
              if (body && body.length > 0) interceptedCaptions = body;
            } catch {}
          }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
        await page.waitForTimeout(2000);

        // Extract caption track URLs and metadata from ytInitialPlayerResponse
        const meta = await page.evaluate(() => {
          const r = window.ytInitialPlayerResponse || (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);
          if (!r) return { title: '', tracks: [] };
          const tracks = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          return {
            title: r?.videoDetails?.title || '',
            tracks: tracks.map(t => ({ code: t.languageCode, name: t.name?.simpleText || t.languageCode, kind: t.kind || 'manual', url: t.baseUrl })),
          };
        });

        log('info', 'youtube transcript: extracted caption tracks', { reqId, title: meta.title, trackCount: meta.tracks.length, tracks: meta.tracks.map(t => t.code) });

        // Strategy A: Fetch caption track URL directly from ytInitialPlayerResponse
        if (meta.tracks && meta.tracks.length > 0) {
          const track = meta.tracks.find(t => t.code === lang) || meta.tracks[0];
          if (track && track.url) {
            const captionUrl = track.url + (track.url.includes('?') ? '&' : '?') + 'fmt=json3';
            log('info', 'youtube transcript: fetching caption track', { reqId, lang: track.code, url: captionUrl.substring(0, 100) });
            try {
              const captionResp = await page.evaluate(async (fetchUrl) => {
                const resp = await fetch(fetchUrl);
                return resp.ok ? await resp.text() : null;
              }, captionUrl);
              if (captionResp && captionResp.length > 0) {
                let transcriptText = null;
                if (captionResp.trimStart().startsWith('{')) transcriptText = parseJson3(captionResp);
                else if (captionResp.includes('WEBVTT')) transcriptText = parseVtt(captionResp);
                else if (captionResp.includes('<text')) transcriptText = parseXml(captionResp);
                if (transcriptText && transcriptText.trim()) {
                  return {
                    status: 'ok', transcript: transcriptText,
                    video_url: url, video_id: videoId, video_title: meta.title,
                    language: track.code, total_words: transcriptText.split(/\s+/).length,
                    available_languages: meta.tracks.map(t => ({ code: t.code, name: t.name, kind: t.kind })),
                  };
                }
              }
            } catch (fetchErr) {
              log('warn', 'youtube transcript: caption track fetch failed', { reqId, error: fetchErr.message });
            }
          }
        }

        // Strategy B: Play video and intercept timedtext network response
        await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v) { v.muted = true; v.play().catch(() => {}); }
        }).catch(() => {});

        for (let i = 0; i < 40 && !interceptedCaptions; i++) {
          await page.waitForTimeout(500);
        }

        if (!interceptedCaptions) {
          return {
            status: 'error', code: 404,
            message: 'No captions available for this video',
            video_url: url, video_id: videoId, title: meta.title,
          };
        }

        log('info', 'youtube transcript: intercepted captions', { reqId, len: interceptedCaptions.length });

        let transcriptText = null;
        if (interceptedCaptions.trimStart().startsWith('{')) transcriptText = parseJson3(interceptedCaptions);
        else if (interceptedCaptions.includes('WEBVTT')) transcriptText = parseVtt(interceptedCaptions);
        else if (interceptedCaptions.includes('<text')) transcriptText = parseXml(interceptedCaptions);

        if (!transcriptText || !transcriptText.trim()) {
          return {
            status: 'error', code: 404,
            message: 'Caption data intercepted but could not be parsed',
            video_url: url, video_id: videoId, title: meta.title,
          };
        }

        return {
          status: 'ok', transcript: transcriptText,
          video_url: url, video_id: videoId, video_title: meta.title,
          language: lang, total_words: transcriptText.split(/\s+/).length,
          available_languages: meta.languages,
        };
      } finally {
        try {
          if (page) await safePageClose(page);
        } finally {
          finishOperation();
        }
        if (session) {
          try {
            await destroySessionCoordinated(ytKey, 'youtube_transcript_cleanup', {
              expectedSession: session,
              shouldDestroy: current => {
                try {
                  return current.context.pages().length === 0;
                } catch {
                  return true;
                }
              },
            });
          } catch (closeError) {
            if (closeError?.code !== 'session_deletion_inflight') {
              log('warn', 'youtube transcript session cleanup failed', {
                error: closeError.message,
              });
            }
          }
        }
      }
    });
  }
}
