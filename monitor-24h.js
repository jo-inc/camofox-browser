#!/usr/bin/env node
/**
 * 24-Hour Health Monitoring & Logging
 * Monitors Camofox stability for production agent systems
 *
 * Use cases: SaaS operations, VA claims, real estate investing
 */

const BASE_URL = 'http://localhost:9377';
const MONITOR_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOG_FILE = '/tmp/camofox-monitor-24h.log';
const fs = require('fs');

const metrics = {
  startTime: Date.now(),
  checksCompleted: 0,
  successCount: 0,
  failureCount: 0,
  crashes: [],
  resourceMetrics: [],
  uptimePercent: 0,
};

function log(level, msg, data = {}) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    msg,
    ...data,
  };
  const line = JSON.stringify(entry);
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function healthCheck() {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const health = await response.json();

    metrics.checksCompleted++;

    if (health.ok && health.browserConnected && health.browserRunning) {
      metrics.successCount++;
      log('info', 'Health check passed', {
        memory: health.memory.rssMb,
        failureCount: health.consecutiveFailures,
      });
    } else {
      metrics.failureCount++;
      log('warn', 'Health check degraded', {
        ok: health.ok,
        connected: health.browserConnected,
        running: health.browserRunning,
      });
    }

    // Log resource metrics
    metrics.resourceMetrics.push({
      timestamp: Date.now(),
      rss: health.memory.rssMb,
      heap: health.memory.heapUsedMb,
      native: health.memory.nativeMemMb,
    });

    // Alert on resource spike
    if (health.memory.rssMb > 500) {
      log('error', 'ALERT: High memory usage', {
        rss: health.memory.rssMb,
        threshold: 500,
      });
      metrics.crashes.push({
        type: 'memory_spike',
        timestamp: Date.now(),
        value: health.memory.rssMb,
      });
    }

    // Alert on consecutive failures
    if (health.consecutiveFailures > 0) {
      log('error', 'ALERT: Health probe failures', {
        failures: health.consecutiveFailures,
      });
      metrics.crashes.push({
        type: 'health_probe_failure',
        timestamp: Date.now(),
        count: health.consecutiveFailures,
      });
    }

  } catch (err) {
    metrics.failureCount++;
    log('error', 'Health check failed', {
      error: err.message,
    });
    metrics.crashes.push({
      type: 'connection_error',
      timestamp: Date.now(),
      error: err.message,
    });
  }
}

async function testAgentWorkload() {
  try {
    // Simulate realistic agent workload
    const userId = `agent-workload-${Date.now()}`;

    // Create tab
    const createRes = await fetch(`${BASE_URL}/tabs/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        url: 'https://example.com'
      }),
    });

    const { tabId } = await createRes.json();

    // Wait for render
    await new Promise(r => setTimeout(r, 1000));

    // Extract content
    const snapRes = await fetch(
      `${BASE_URL}/tabs/${tabId}/snapshot?userId=${userId}`
    );
    const snap = await snapRes.json();

    log('info', 'Agent workload test passed', {
      tabId: tabId.slice(0, 8),
      contentLength: snap.totalChars,
    });

  } catch (err) {
    log('warn', 'Agent workload test failed', {
      error: err.message,
    });
  }
}

async function monitor() {
  log('info', 'Starting 24-hour monitoring', {
    interval: `${CHECK_INTERVAL_MS / 1000}s`,
    duration: `${MONITOR_DURATION_MS / 3600000}h`,
  });

  const endTime = Date.now() + MONITOR_DURATION_MS;

  while (Date.now() < endTime) {
    await healthCheck();

    // Run agent workload test every hour
    if (metrics.checksCompleted % 12 === 0) {
      await testAgentWorkload();
    }

    // Wait for next check
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }

  // Final report
  metrics.uptimePercent = (metrics.successCount / metrics.checksCompleted * 100).toFixed(2);

  log('info', '24-hour monitoring complete', {
    checks: metrics.checksCompleted,
    successes: metrics.successCount,
    failures: metrics.failureCount,
    uptime: `${metrics.uptimePercent}%`,
    incidents: metrics.crashes.length,
  });

  console.log('\n📊 Final Report:');
  console.log(`  Checks completed: ${metrics.checksCompleted}`);
  console.log(`  Uptime: ${metrics.uptimePercent}%`);
  console.log(`  Incidents: ${metrics.crashes.length}`);
  console.log(`  Log file: ${LOG_FILE}\n`);

  if (metrics.crashes.length > 0) {
    console.log('⚠️  Incidents detected:');
    metrics.crashes.forEach(c => {
      console.log(`  - ${c.type} at ${new Date(c.timestamp).toISOString()}`);
    });
  }
}

monitor().catch(err => {
  log('error', 'Monitor crashed', { error: err.message });
  console.error(err);
  process.exit(1);
});
