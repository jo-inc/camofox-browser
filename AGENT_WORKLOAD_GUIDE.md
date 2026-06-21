# Agent Workload Testing & Production Guide

For business-critical agent systems: SaaS operations, VA claims, real estate investing, analytics

## Business Use Cases

### 1. SaaS Startup Operations Agent
**Requirements**:
- Multi-tab workflows (5-10 concurrent)
- Long-running sessions (hours)
- Session persistence across restarts
- Form filling and interaction
- Data extraction and processing

**Key Sites**: SaaS dashboards, customer portals, analytics platforms

**Anti-Detection Need**: Medium (most SaaS sites don't heavily detect automation)

---

### 2. VA Claim Advocate Agent
**Requirements**:
- High anti-detection (VA.gov is detection-heavy)
- Session persistence (claims take days to process)
- Screenshot/content capture for documentation
- Form navigation and submission
- Complex multi-step workflows

**Key Sites**: VA.gov, claims systems, benefits portals

**Anti-Detection Need**: CRITICAL (VA.gov heavily detects bots)

**Special Considerations**:
- VA.gov specifically blocks headless browsers
- Requires real browser fingerprints
- May detect rapid interactions
- Needs realistic delays between actions

---

### 3. Real Estate Investing Agent
**Requirements**:
- Multi-listing research (20+ MLS sites)
- Price tracking and data extraction
- Comparison analysis across sites
- Geographic scaling (multiple regions)
- Proxy rotation for multi-region access

**Key Sites**: MLS systems, property databases, market data

**Anti-Detection Need**: High (MLS requires authentication, rate limiting)

---

### 4. SaaS Real Estate Analytics Agent
**Requirements**:
- Data pipeline execution
- Market analysis automation
- Report generation
- Real-time data collection
- API rate limiting handling

**Key Sites**: Real estate APIs, market data providers, analytics platforms

**Anti-Detection Need**: Medium (APIs have rate limiting, not detection)

---

## Performance Baselines

Run these benchmarks to establish healthy performance:

### Baseline 1: Single Tab Lifecycle
```bash
# Expected: <2 seconds
- Create tab → Load page → Extract content → Screenshot → Close
```

### Baseline 2: Multi-Tab Session
```bash
# Expected: <5 seconds for 5 tabs
- Create 5 tabs in parallel
- Each tab loads different site
- Extract content from all
- Measure total time
```

### Baseline 3: Long-Running Session
```bash
# Expected: Stable for 1+ hour
- Create single tab
- Navigate every 5 minutes
- Extract content each time
- Monitor memory/crashes
- Run for 60 minutes
```

### Baseline 4: Concurrent Agent Workloads
```bash
# Expected: Handle 3 agents without conflicts
- Run 3 independent agents simultaneously
- Each with different session/user
- Measure latency and success rate
```

---

## Edge Cases by Use Case

### SaaS Operations Agent

**Edge Case 1: Session Timeout**
- Problem: SaaS sites timeout sessions after 30 minutes
- Solution: Refresh session token before timeout
- Test: `navigate /refresh` endpoint before session expires
- Verify: No 401 errors after 35 minutes

**Edge Case 2: CSRF Token Rotation**
- Problem: Forms require fresh CSRF tokens
- Solution: Extract token from page before each form submit
- Test: Submit multiple forms in sequence
- Verify: All submissions succeed

**Edge Case 3: Rate Limiting**
- Problem: SaaS APIs may rate limit requests
- Solution: Implement exponential backoff
- Test: Rapid form submissions
- Verify: 429 errors handled gracefully

---

### VA Claims Advocate Agent

**Edge Case 1: VA.gov Bot Detection (CRITICAL)**
- Problem: VA heavily detects browser automation
- Detection methods:
  - `navigator.webdriver` check
  - Headless mode detection
  - Canvas fingerprinting
  - WebGL fingerprinting
  - Request timing analysis

**Solution**: Camofox handles these with:
- Real Firefox binary (not headless)
- Hardware rendering via Xvfb
- Canvas/WebGL matching real browsers
- Random interaction delays

**Test Plan**:
```javascript
// Test 1: Navigate to VA.gov login
await navigate('https://www.va.gov/');

// Test 2: Check detection signals
const detection = await page.evaluate(() => {
  return {
    webdriver: navigator.webdriver,
    headless: navigator.headless,
    chromeRunning: window.chrome !== undefined,
  };
});

// Expected: { webdriver: undefined, headless: undefined, chromeRunning: false }
if (detection.webdriver || detection.headless) {
  console.log('⚠️  DETECTION RISK');
}

// Test 3: Login attempt
await login(username, password);

// Test 4: Navigate to claims
await navigate('/my-benefits/claims/');

// Verify: No 403/blocking errors
```

**Edge Case 2: Multi-Day Session Persistence**
- Problem: VA claims take days; session must persist
- Solution: Store cookies/session state
- Test:
  1. Create session
  2. Save cookies
  3. Close browser
  4. Restart browser
  5. Restore cookies
  6. Access protected page
- Verify: Access succeeds, claim data visible

**Edge Case 3: Document Upload**
- Problem: Uploading documents to VA portal
- Solution: Camofox doesn't support file upload in REST API
- Workaround: Use Puppeteer for file operations, Camofox for navigation
- Test: Upload document, verify appears in portal

---

### Real Estate Investing Agent

**Edge Case 1: Proxy Rotation Across MLS Systems**
- Problem: Different regional MLS systems
- Solution: Rotate proxies by region
- Configuration:
```javascript
const regions = ['CA', 'TX', 'FL', 'NY'];
for (const region of regions) {
  await setProxy(`residential-${region}.proxy.com`);
  await navigate(`mls.${region}.local`);
  await extractData();
}
```

**Test**: 
- Verify each region loads correctly
- Monitor for proxy detection (403 errors)
- Log access times per region

**Edge Case 2: Rate Limiting on Data Extraction**
- Problem: MLS sites rate limit rapid requests
- Solution: Implement backoff and caching
```javascript
const requestCache = new Map();
async function fetchData(url, ttl = 3600000) {
  if (requestCache.has(url)) {
    const cached = requestCache.get(url);
    if (Date.now() - cached.time < ttl) {
      return cached.data;
    }
  }
  
  const data = await navigate(url);
  requestCache.set(url, { data, time: Date.now() });
  return data;
}
```

**Test**:
- Rapid requests (should hit cache)
- Rate limit errors (should backoff)
- Verify total request time under 10s for 20 listings

**Edge Case 3: Geographic Variance**
- Problem: MLS data varies by region
- Solution: Validate data format per region
- Test:
  - CA: Price in $/sqft, beds/baths
  - TX: Price, lot size, days on market
  - Check field names vary by region
  - Normalize before analysis

---

### SaaS Real Estate Analytics Agent

**Edge Case 1: API Rate Limiting**
- Problem: APIs have limits (e.g., 100 req/min)
- Solution: Distribute requests over time
```javascript
async function rateLimit(requests, rps = 2) {
  // 2 requests per second = 120/minute
  for (const req of requests) {
    await executeRequest(req);
    await new Promise(r => setTimeout(r, 1000 / rps));
  }
}
```

**Test**:
- Send requests at limit boundary (100 req/min)
- Verify: No 429 errors
- Measure: Request distribution is smooth

**Edge Case 2: Data Freshness**
- Problem: Real estate data updates throughout day
- Solution: Schedule refreshes during off-peak
- Test:
  - Fetch at 2 AM (off-peak)
  - Fetch at 2 PM (peak)
  - Verify both succeed
  - Compare response times

**Edge Case 3: Pipeline Failure Recovery**
- Problem: If one step fails, whole pipeline fails
- Solution: Implement checkpoints and retry logic
```javascript
const checkpoint = async (name, fn) => {
  try {
    const result = await fn();
    log(`✅ ${name}`);
    return result;
  } catch (err) {
    log(`❌ ${name}: ${err.message}`);
    // Retry or skip based on importance
    throw err;
  }
};

await checkpoint('fetch listings', () => fetchListings());
await checkpoint('analyze prices', () => analyzeMarket());
await checkpoint('generate report', () => generateReport());
```

**Test**:
- Simulate network failure in middle of pipeline
- Verify: Can resume from last checkpoint
- No data loss or duplication

---

## Production Deployment Checklist

- [ ] **Monitoring**: 24h health check running
  ```bash
  node monitor-24h.js &
  ```

- [ ] **Logging**: All agent actions logged
  ```javascript
  const logger = (level, msg, data) => {
    console.log(JSON.stringify({ timestamp: new Date(), level, msg, ...data }));
  };
  ```

- [ ] **Error Handling**: Crashes don't lose state
  ```javascript
  process.on('uncaughtException', async (err) => {
    await saveState();
    process.exit(1);
  });
  ```

- [ ] **Resource Limits**: Memory capped
  ```bash
  docker run --memory=1g camofox-browser
  ```

- [ ] **Session Persistence**: State survives restart
  ```javascript
  const saveSession = (userId, cookies) => fs.writeFileSync(`sessions/${userId}.json`, JSON.stringify(cookies));
  const loadSession = (userId) => JSON.parse(fs.readFileSync(`sessions/${userId}.json`));
  ```

- [ ] **Proxy Rotation**: Working for multi-region agents
  ```javascript
  const proxies = ['proxy1.com', 'proxy2.com', 'proxy3.com'];
  const proxy = proxies[Math.random() * proxies.length | 0];
  ```

- [ ] **Anti-Detection**: Tested against target sites
  - [ ] VA.gov (most strict)
  - [ ] MLS systems (medium)
  - [ ] SaaS platforms (low)

- [ ] **Load Testing**: Can handle concurrent agents
  ```bash
  npm run load-test -- --agents 3 --duration 1h
  ```

---

## Troubleshooting Production Issues

### Issue: "Connection refused" errors

**Causes**:
1. Camofox container crashed
2. API server restarted
3. Network issue

**Diagnosis**:
```bash
curl http://localhost:9377/health
docker ps | grep camofox
docker logs camofox-browser | tail -20
```

**Fix**: Restart container and resume agents from checkpoint

---

### Issue: "cannot open display" errors

**Cause**: Xvfb display initialization failed  
**Status**: FIXED in our code  
**Diagnosis**: Check that await was applied to line 955

---

### Issue: "viewport.isMobile" schema error

**Cause**: Health probe CDP schema mismatch  
**Status**: FIXED in our code  
**Diagnosis**: Check that viewport: null applied to lines 710, 1180

---

### Issue: High memory usage (>500MB)

**Causes**:
1. Too many concurrent tabs
2. Memory leak in browser
3. Large page datasets

**Mitigation**:
```javascript
// Limit concurrent tabs
const MAX_CONCURRENT = 5;
const queue = [];
for (const tab of tabs) {
  if (queue.length >= MAX_CONCURRENT) {
    await Promise.race(queue);
  }
  queue.push(processTab(tab));
}
```

---

## Monitoring Dashboard Metrics

Track these in production:

```javascript
{
  uptime_percent: 99.8,
  health_checks_passed: 288,
  health_checks_failed: 0,
  avg_response_time_ms: 1250,
  avg_memory_mb: 245,
  max_memory_mb: 380,
  agent_sessions_active: 3,
  total_tabs_created: 450,
  errors_last_24h: 0,
  incidents: []
}
```

---

## Support & Escalation

**Level 1 - Agent Self-Healing** (auto-retry, checkpoint resume)  
**Level 2 - Health Check Alert** (notify ops, restart container)  
**Level 3 - Manual Investigation** (logs, memory dump, git bisect)  
**Level 4 - Fallback** (use Browserbase cloud service temporarily)

---

## Success Criteria for Production

- ✅ 99%+ uptime over 30 days
- ✅ Zero unhandled crashes
- ✅ Memory stable (<400MB)
- ✅ All target sites working (VA, MLS, SaaS)
- ✅ Anti-detection confirmed working
- ✅ Agents complete workflows without manual intervention
