# Upstream Contribution Plan

Document the critical bugs we discovered and potential contributions to the Camofox project.

## Issues to Report

### Issue 1: Display Initialization Missing Await
**Severity**: CRITICAL  
**File**: `server.js:955`  
**Description**: `VirtualDisplay.get()` is async but not awaited, causing "Error: cannot open display: [object Promise]"

```javascript
// BROKEN:
vdDisplay = localVirtualDisplay.get();

// FIXED:
vdDisplay = await localVirtualDisplay.get();
```

**Impact**: Breaks display initialization on Linux with VNC plugin enabled
**Status**: Ready to submit as PR

---

### Issue 2: CDP Schema Mismatch - Viewport Property
**Severity**: CRITICAL  
**File**: `server.js:1180, 710`  
**Description**: Playwright sends `isMobile: false` in viewport which Camofox 135.0.1 CDP doesn't recognize

**Error**:
```
Found property "<root>.viewport.isMobile" - false which is not described in this scheme
```

**Affects**:
- Session creation (health probe crashes every 3 minutes)
- Proxy validation (testing fails)

**Fix**: Set `viewport: null` to avoid CDP schema validation
```javascript
// BEFORE:
context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});

// AFTER:
context = await browser.newContext({
  viewport: null,
});
```

**Root Cause**: Possible Playwright/Camoufox CDP version mismatch. Investigate if:
- Camoufox should accept `isMobile` property
- Playwright should conditionally send it
- Version compatibility matrix exists

**Status**: Needs investigation - may require coordination with both projects

---

## Missing Documentation

### 1. Docker Deployment Guide
**What's Missing**:
- How to run Camofox as a service in Docker
- Environment variables for production
- Port exposure and networking
- Health check configuration
- VNC plugin setup

**Recommendation**: Create `docs/docker-deployment.md` with:
- Docker Compose example
- Environment variable reference
- Troubleshooting guide
- Performance tuning

---

### 2. VNC Plugin Documentation
**What's Missing**:
- VNC plugin is disabled by default
- No docs on enabling it
- No docs on accessing it
- No docs on password protection

**Current behavior**:
- Plugin installed but needs manual config
- Users must edit `camofox.config.json` to enable
- noVNC web interface at `http://localhost:6080` (undocumented)
- VNC server on port 5900 (undocumented)

**Recommendation**: Document in plugin docs:
- How to enable VNC plugin
- How to access via noVNC web UI
- How to set VNC password
- Port requirements and networking

---

### 3. Health Probe Configuration
**What's Missing**:
- Health probe runs every 60 seconds
- Fails on CDP schema mismatches
- Causes browser restart loop
- No documentation on health check behavior

**Recommendation**: Add to docs:
- What health probe does
- How to interpret health metrics
- How to configure health check interval
- Known health probe issues and workarounds

---

## Proposed Pull Requests

### PR #1: Fix Display Initialization (Display fix)
**Title**: "Fix: Await async VirtualDisplay.get() call on Linux"  
**Files Changed**: `server.js` (line 955)  
**Lines**: +1  
**Status**: Ready to submit  
**Risk**: Very low - simple missing await

---

### PR #2: Fix CDP Schema Mismatch (Viewport fix)
**Title**: "Fix: CDP viewport schema mismatch in session/probe contexts"  
**Files Changed**: `server.js` (lines 710, 1180)  
**Lines**: +2  
**Status**: Ready but needs investigation  
**Risk**: Low - setting viewport:null is safe and documented behavior  
**Note**: Coordinate with Playwright maintainers about root cause

---

### PR #3: Add Docker Deployment Documentation
**Title**: "docs: Add Docker deployment and environment variable guide"  
**Files**: New file `docs/docker-deployment.md`  
**Status**: Can prepare from our SETUP_GUIDE.md  
**Risk**: Very low - docs only

---

### PR #4: Document VNC Plugin Configuration
**Title**: "docs: Document VNC plugin setup and noVNC access"  
**Files**: Update plugin docs  
**Status**: Can prepare from our testing experience  
**Risk**: Very low - docs only

---

## Contribution Strategy

### Phase 1: Low-risk PRs (Week 1)
1. Submit display initialization fix (PR #1)
2. Submit documentation PRs (#3, #4)
3. Get feedback on viewport fix approach (PR #2)

### Phase 2: Investigation (Week 2)
1. Coordinate with Playwright on CDP schema
2. Test viewport fix against different Playwright versions
3. Validate fix doesn't break other browsers

### Phase 3: Final PRs (Week 3)
1. Submit viewport fix with full explanation
2. Incorporate feedback from maintainers
3. Close out all contributions

---

## Contact & Communication

**Camoufox Repository**: https://github.com/jo-inc/camofox  
**Suggested Issues**:
1. "Display initialization breaks on Linux with VNC"
2. "CDP viewport schema error crashes health probe"
3. "Documentation gap: Docker deployment"

**Communication Style**:
- Link to our SETUP_GUIDE.md as evidence
- Provide clear reproduction steps
- Show fix with before/after code
- Include test results from test suite

---

## Risk Assessment

| Change | Risk | Impact | Priority |
|--------|------|--------|----------|
| Display await fix | Very Low | Critical bug | HIGH |
| Viewport null fix | Low | Critical bug | HIGH |
| Docker docs | None | Important | MEDIUM |
| VNC plugin docs | None | Important | MEDIUM |

---

## Success Criteria

- [ ] All 3 critical fixes merged upstream
- [ ] Docker deployment docs accepted
- [ ] VNC plugin docs updated
- [ ] No regression in our fork
- [ ] Future Camofox users benefit from our fixes

---

## Timeline

**Estimated**: 3 weeks  
**Effort**: 
- Code changes: ~30 minutes (very minimal)
- Documentation: ~2 hours
- Communication/reviews: ~4 hours

**Next Action**: Open first GitHub issue with display initialization bug
