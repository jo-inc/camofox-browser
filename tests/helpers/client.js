const crypto = require('crypto');

class BrowserClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.userId = crypto.randomUUID();
    this.sessionKey = crypto.randomUUID();
    this.listItemId = this.sessionKey; // Legacy alias
    this.tabs = [];
    this.timeout = 30000; // 30 second default timeout
  }
  
  async request(method, path, body = null, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);
    
    try {
      const fetchOptions = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      };
      
      if (body) {
        fetchOptions.body = JSON.stringify(body);
      }
      
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);
      
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const data = await response.json();
        if (!response.ok) {
          const error = new Error(data.error || `HTTP ${response.status}`);
          error.status = response.status;
          error.data = data;
          throw error;
        }
        return data;
      } else if (contentType?.includes('image/')) {
        return await response.arrayBuffer();
      } else {
        return await response.text();
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error(`Request timeout after ${options.timeout || this.timeout}ms: ${method} ${path}`);
      }
      throw err;
    }
  }
  
  // Health check
  async health() {
    return this.request('GET', '/health');
  }
  
  // Tab management
  async createTab(url = null) {
    const body = { userId: this.userId, sessionKey: this.sessionKey };
    if (url) body.url = url;
    
    const result = await this.request('POST', '/tabs', body);
    if (result.tabId) {
      this.tabs.push(result.tabId);
    }
    return result;
  }
  
  async navigate(tabId, urlOrMacro) {
    // Support both regular URLs and @macro syntax
    if (urlOrMacro.startsWith('@')) {
      const [macro, ...queryParts] = urlOrMacro.split(' ');
      const query = queryParts.join(' ');
      return this.request('POST', `/tabs/${tabId}/navigate`, { userId: this.userId, macro, query });
    }
    return this.request('POST', `/tabs/${tabId}/navigate`, { userId: this.userId, url: urlOrMacro });
  }
  
  async getSnapshot(tabId, options = {}) {
    const params = new URLSearchParams({ userId: this.userId });
    if (options.includeScreenshot) params.append('includeScreenshot', 'true');
    if (options.offset) params.append('offset', String(options.offset));
    return this.request('GET', `/tabs/${tabId}/snapshot?${params}`);
  }
  
  async click(tabId, options) {
    return this.request('POST', `/tabs/${tabId}/click`, { userId: this.userId, ...options });
  }
  
  async type(tabId, options) {
    const { pressEnter, clear, ...typeOptions } = options;
    
    // Handle clear by selecting all first
    if (clear && (options.selector || options.ref)) {
      // Click to focus, then select all and type to replace
      await this.click(tabId, { selector: options.selector, ref: options.ref });
      await this.press(tabId, 'Control+a');
    }
    
    const result = await this.request('POST', `/tabs/${tabId}/type`, { userId: this.userId, ...typeOptions });
    
    // Handle Enter key press after typing
    if (pressEnter) {
      await this.press(tabId, 'Enter');
    }
    
    return result;
  }
  
  async press(tabId, key) {
    return this.request('POST', `/tabs/${tabId}/press`, { userId: this.userId, key });
  }
  
  async scroll(tabId, options) {
    return this.request('POST', `/tabs/${tabId}/scroll`, { userId: this.userId, ...options });
  }
  
  async back(tabId) {
    return this.request('POST', `/tabs/${tabId}/back`, { userId: this.userId });
  }
  
  async forward(tabId) {
    return this.request('POST', `/tabs/${tabId}/forward`, { userId: this.userId });
  }
  
  async refresh(tabId) {
    return this.request('POST', `/tabs/${tabId}/refresh`, { userId: this.userId });
  }
  
  async getLinks(tabId, options = {}) {
    const params = new URLSearchParams({ userId: this.userId });
    if (options.limit) params.append('limit', options.limit);
    if (options.offset) params.append('offset', options.offset);
    return this.request('GET', `/tabs/${tabId}/links?${params}`);
  }
  
  async getStats(tabId) {
    return this.request('GET', `/tabs/${tabId}/stats?userId=${this.userId}`);
  }
  
  async screenshot(tabId, fullPage = false) {
    return this.request('GET', `/tabs/${tabId}/screenshot?userId=${this.userId}&fullPage=${fullPage}`);
  }
  
  async closeTab(tabId) {
    const result = await this.request('DELETE', `/tabs/${tabId}`, { userId: this.userId });
    this.tabs = this.tabs.filter(t => t !== tabId);
    return result;
  }
  
  async closeTabGroup(sessionKey = null) {
    return this.request('DELETE', `/tabs/group/${sessionKey || this.sessionKey}`, { userId: this.userId });
  }
  
  async closeSession() {
    return this.request('DELETE', `/sessions/${this.userId}`);
  }
  
  // Cleanup all tabs created by this client
  async cleanup() {
    for (const tabId of [...this.tabs]) {
      try {
        await this.closeTab(tabId);
      } catch (e) {
        // Tab may already be closed
      }
    }
    try {
      await this.closeSession();
    } catch (e) {
      // Session may already be closed
    }
  }
  
  // Wait for snapshot to contain specific text (polling)
  async waitForSnapshotContains(tabId, text, options = {}) {
    const maxWait = options.maxWait || 10000;
    const interval = options.interval || 500;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      const snapshot = await this.getSnapshot(tabId);
      if (snapshot.snapshot && snapshot.snapshot.includes(text)) {
        return snapshot;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    
    throw new Error(`Timeout waiting for snapshot to contain "${text}"`);
  }
  
  // Wait for URL to match pattern
  async waitForUrl(tabId, pattern, options = {}) {
    const maxWait = options.maxWait || 10000;
    const interval = options.interval || 500;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      const snapshot = await this.getSnapshot(tabId);
      const url = snapshot.url;
      
      if (typeof pattern === 'string' && url.includes(pattern)) {
        return snapshot;
      } else if (pattern instanceof RegExp && pattern.test(url)) {
        return snapshot;
      }
      
      await new Promise(r => setTimeout(r, interval));
    }
    
    throw new Error(`Timeout waiting for URL to match ${pattern}`);
  }
}

function createClient(baseUrl) {
  return new BrowserClient(baseUrl);
}

module.exports = {
  BrowserClient,
  createClient
};
