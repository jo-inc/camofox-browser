#!/bin/bash
# Docker entrypoint for camofox-browser with automatic cookie loading

set -e

# Configuration
COOKIES_DIR="${CAMOFOX_COOKIES_DIR:-/root/.camofox/cookies}"
SERVER_PORT="${CAMOFOX_PORT:-9377}"
SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
API_KEY="${CAMOFOX_API_KEY:-}"
MAX_WAIT=60

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Parse Netscape cookie file and convert to JSON
parse_cookies() {
    local file="$1"
    local domain_filter="$2"
    
    node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$file', 'utf8').split('\n');
    const cookies = [];
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const parts = trimmed.split('\t');
        if (parts.length < 7) continue;
        
        const [domain, flag, path, secure, expires, name, ...valueParts] = parts;
        
        // Apply domain filter if specified
        if ('$domain_filter' && !domain.includes('$domain_filter')) continue;
        
        const cookie = {
            name,
            value: valueParts.join('\t'),
            domain,
            path,
            secure: secure.toUpperCase() === 'TRUE',
            httpOnly: false
        };
        
        if (expires && expires !== '0') {
            cookie.expires = parseInt(expires);
        }
        
        cookies.push(cookie);
    }
    
    console.log(JSON.stringify(cookies));
    "
}

# Import cookies for a specific user
import_cookies_for_user() {
    local user_id="$1"
    local cookie_file="$2"
    local domain_filter="$3"
    
    if [[ ! -f "$cookie_file" ]]; then
        return 0
    fi
    
    # Skip if no API key is set (cookie import disabled in production without API key)
    if [[ -z "$API_KEY" ]]; then
        log_warn "CAMOFOX_API_KEY not set, skipping cookie import"
        return 1
    fi
    
    log_info "Importing cookies from $(basename "$cookie_file") for user: $user_id"
    
    local cookies_json
    cookies_json=$(parse_cookies "$cookie_file" "$domain_filter")
    local count=$(echo "$cookies_json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).length)")
    
    if [[ "$count" -eq 0 ]]; then
        log_warn "No cookies found in $cookie_file"
        return 0
    fi
    
    # Import cookies via API using Node.js with Authorization header
    local response
    response=$(node -e "
        const http = require('http');
        const data = JSON.stringify({ cookies: $cookies_json });
        const options = {
            hostname: '127.0.0.1',
            port: $SERVER_PORT,
            path: '/sessions/$user_id/cookies',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'Authorization': 'Bearer $API_KEY'
            }
        };
        
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                console.log(body);
                console.log('HTTP_STATUS:' + res.statusCode);
            });
        });
        
        req.on('error', (err) => {
            console.log('Error: ' + err.message);
            console.log('HTTP_STATUS:000');
        });
        
        req.write(data);
        req.end();
    " 2>&1)
    
    local http_code=$(echo "$response" | grep "HTTP_STATUS:" | cut -d: -f2)
    local body=$(echo "$response" | grep -v "HTTP_STATUS:")
    
    if [[ "$http_code" == "200" ]]; then
        log_info "✓ Imported $count cookies for user '$user_id'"
        return 0
    else
        log_error "Failed to import cookies for user '$user_id' (HTTP $http_code): $body"
        return 1
    fi
}

# Auto-import all cookie files from the cookies directory
auto_import_cookies() {
    if [[ ! -d "$COOKIES_DIR" ]]; then
        log_warn "Cookies directory not found: $COOKIES_DIR"
        return 0
    fi
    
    log_info "Auto-importing cookies from: $COOKIES_DIR"
    
    # Define user IDs to import cookies for
    local user_ids=("default" "agent1" "agent" "user" "main")
    
    # Import instagram cookies
    if [[ -f "$COOKIES_DIR/instagram.txt" ]]; then
        for user_id in "${user_ids[@]}"; do
            import_cookies_for_user "$user_id" "$COOKIES_DIR/instagram.txt" "instagram.com" || true
        done
    fi
    
    # Import x/twitter cookies
    if [[ -f "$COOKIES_DIR/x.txt" ]]; then
        for user_id in "${user_ids[@]}"; do
            import_cookies_for_user "$user_id" "$COOKIES_DIR/x.txt" "x.com" || true
        done
    fi
    
    # Import any other .txt cookie files
    for cookie_file in "$COOKIES_DIR"/*.txt; do
        [[ -f "$cookie_file" ]] || continue
        local basename=$(basename "$cookie_file" .txt)
        [[ "$basename" == "instagram" || "$basename" == "x" ]] && continue
        
        for user_id in "${user_ids[@]}"; do
            import_cookies_for_user "$user_id" "$cookie_file" || true
        done
    done
    
    log_info "Cookie import complete"
}

# Wait for server to be ready
wait_for_server() {
    log_info "Waiting for server to be ready at $SERVER_URL..."
    
    local waited=0
    while [[ $waited -lt $MAX_WAIT ]]; do
        if node -e "
            const http = require('http');
            const req = http.get('$SERVER_URL/health', (res) => {
                process.exit(res.statusCode === 200 ? 0 : 1);
            });
            req.on('error', () => process.exit(1));
            req.setTimeout(2000, () => process.exit(1));
        " 2>/dev/null; then
            log_info "Server is ready!"
            return 0
        fi
        sleep 1
        ((waited++))
        
        if [[ $((waited % 5)) -eq 0 ]]; then
            log_info "Still waiting... ($waited seconds)"
        fi
    done
    
    log_error "Server failed to start within $MAX_WAIT seconds"
    return 1
}

# Start the server
start_server() {
    log_info "Starting camofox-browser server on port $SERVER_PORT..."
    
    # Start server in background
    node --max-old-space-size="${MAX_OLD_SPACE_SIZE:-128}" server.js &
    SERVER_PID=$!
    
    # Setup cleanup on exit
    cleanup() {
        log_info "Shutting down server (PID: $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM
    
    # Wait for server to be ready
    if ! wait_for_server; then
        log_error "Server failed to start"
        exit 1
    fi
    
    # Auto-import cookies
    auto_import_cookies
    
    # Keep the server running
    log_info "Server is running. Press Ctrl+C to stop."
    wait "$SERVER_PID"
}

# Main entrypoint
case "${1:-}" in
    server)
        shift
        start_server
        ;;
    import-cookies)
        shift
        # Just import cookies without starting server (server must already be running)
        auto_import_cookies
        ;;
    *)
        # Default: start server with auto-import
        start_server
        ;;
esac
