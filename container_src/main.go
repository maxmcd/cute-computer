package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const (
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins for development
		// In production, you should validate the origin
		return true
	},
}

type ptySession struct {
	cmd  *exec.Cmd
	ptmx *os.File
	ws   *websocket.Conn
	// Do we really need this?
	mu     sync.Mutex
	closed bool
}

type resizeMessage struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// FileInfo represents file metadata for API responses
type FileInfo struct {
	Path  string `json:"path"`  // Relative to /home/cutie
	Name  string `json:"name"`  // Basename of file
	IsDir bool   `json:"isDir"` // True if directory
	Size  int64  `json:"size"`  // File size in bytes
}

// MoveRequest represents a file move/rename operation
type MoveRequest struct {
	From string `json:"from"` // Source path (relative to /home/cutie)
	To   string `json:"to"`   // Destination path (relative to /home/cutie)
}

// Config represents the user's configuration file
type Config struct {
	Static string `json:"static"`
}

// ConfigCache holds the parsed config with its modification time
type ConfigCache struct {
	config  *Config
	modTime time.Time
	mu      sync.RWMutex
}

var configCache = &ConfigCache{}

// waitForMount polls until the directory is a FUSE mount (not a regular directory)
func waitForMount(path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	const FUSE_SUPER_MAGIC = 0x65735546 // FUSE filesystem magic number

	for range ticker.C {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(path, &stat); err == nil {
			// Check if it's a FUSE filesystem
			if stat.Type == FUSE_SUPER_MAGIC {
				log.Printf("Mount at %s is ready (FUSE detected)", path)
				return nil
			}
		}

		if time.Now().After(deadline) {
			return fmt.Errorf("timeout waiting for FUSE mount at %s", path)
		}
	}
	return fmt.Errorf("ticker closed unexpectedly")
}

// validateAndResolvePath validates a relative path and converts it to absolute
// Returns absolute path within /home/cutie or error if invalid
func validateAndResolvePath(relativePath string) (string, error) {
	// Clean the path to remove .. and .
	cleanPath := filepath.Clean(relativePath)

	// Remove leading slash if present
	cleanPath = strings.TrimPrefix(cleanPath, "/")

	// Build absolute path
	absPath := filepath.Join("/home/cutie", cleanPath)

	// Security check: ensure path is within /home/cutie
	if !strings.HasPrefix(absPath, "/home/cutie/") && absPath != "/home/cutie" {
		return "", fmt.Errorf("invalid path: must be within /home/cutie")
	}

	return absPath, nil
}

// toRelativePath converts absolute path to relative (strips /home/cutie prefix)
func toRelativePath(absPath string) string {
	// Remove /home/cutie/ prefix
	rel := strings.TrimPrefix(absPath, "/home/cutie/")
	// Also handle exact match for /home/cutie (root)
	if rel == absPath {
		rel = strings.TrimPrefix(absPath, "/home/cutie")
	}
	// Remove leading slash
	rel = strings.TrimPrefix(rel, "/")
	return rel
}

// writeLog sends a log entry to the Logs Durable Object
func writeLog(logMessage string) {
	// Get logs endpoint from environment (set by container runtime)
	logsEndpoint := os.Getenv("LOGS_ENDPOINT")
	logsToken := os.Getenv("LOGS_TOKEN")

	// Replace entire host with host.docker.internal if URL contains localhost
	if strings.Contains(logsEndpoint, "localhost") {
		if parsedURL, err := url.Parse(logsEndpoint); err == nil {
			parsedURL.Host = strings.Replace(parsedURL.Host, parsedURL.Hostname(), "host.docker.internal", 1)
			logsEndpoint = parsedURL.String()
		}
	}

	if logsEndpoint == "" || logsToken == "" {
		// Silently skip if not configured
		return
	}

	// Create log entry with nanosecond timestamp
	ts := fmt.Sprintf("%d", time.Now().UnixNano())
	logEntry := map[string]interface{}{
		"ts":  ts,
		"log": logMessage,
	}

	logs := []map[string]interface{}{logEntry}
	jsonData, err := json.Marshal(logs)
	if err != nil {
		log.Printf("Failed to marshal log: %v", err)
		return
	}

	// Send to logs endpoint
	req, err := http.NewRequest("POST", logsEndpoint+"/write", strings.NewReader(string(jsonData)))
	if err != nil {
		log.Printf("Failed to create log request: %v", err)
		return
	}

	req.Header.Set("Authorization", "Bearer "+logsToken)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Failed to send log: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Log write failed: %d - %s", resp.StatusCode, string(body))
	}
}

// ensureConfigExists creates a default config file if none exists
func ensureConfigExists() error {
	// Check for both .json and .jsonc
	configPath := ""
	if _, err := os.Stat("/home/cutie/config.json"); err == nil {
		return nil // config.json exists
	}
	if _, err := os.Stat("/home/cutie/config.jsonc"); err == nil {
		return nil // config.jsonc exists
	}

	// Neither exists, create default config.json
	configPath = "/home/cutie/config.json"
	defaultConfig := `{
  "static": "."
}`

	if err := os.WriteFile(configPath, []byte(defaultConfig), 0644); err != nil {
		return fmt.Errorf("failed to create default config: %w", err)
	}

	log.Printf("Created default config at %s", configPath)
	return nil
}

// loadConfig loads the config file with caching based on modification time
func loadConfig() (*Config, error) {
	// Find which config file exists
	configPath := ""
	if _, err := os.Stat("/home/cutie/config.json"); err == nil {
		configPath = "/home/cutie/config.json"
	} else if _, err := os.Stat("/home/cutie/config.jsonc"); err == nil {
		configPath = "/home/cutie/config.jsonc"
	} else {
		return nil, fmt.Errorf("no config file found (tried config.json and config.jsonc)")
	}

	// Stat the file to check modification time
	info, err := os.Stat(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to stat config file: %w", err)
	}

	// Check cache
	configCache.mu.RLock()
	if configCache.config != nil && configCache.modTime.Equal(info.ModTime()) {
		config := configCache.config
		configCache.mu.RUnlock()
		return config, nil
	}
	configCache.mu.RUnlock()

	// Need to reload
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	// Strip comments for JSONC support
	data = sanitizeJSONC(data)

	// Parse JSON
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config JSON: %w", err)
	}

	// Validate
	if config.Static == "" {
		return nil, fmt.Errorf("config.static field is required")
	}

	// Update cache
	configCache.mu.Lock()
	configCache.config = &config
	configCache.modTime = info.ModTime()
	configCache.mu.Unlock()

	log.Printf("Loaded config from %s: static=%s", configPath, config.Static)
	return &config, nil
}

// resolveStaticPath resolves the static directory path securely
func resolveStaticPath(staticPath string) (string, error) {
	// Resolve relative to /home/cutie
	var fullPath string
	if filepath.IsAbs(staticPath) {
		fullPath = staticPath
	} else {
		fullPath = filepath.Join("/home/cutie", staticPath)
	}

	// Clean the path to remove .. and .
	fullPath = filepath.Clean(fullPath)

	// Security: ensure path is within /home/cutie
	if !strings.HasPrefix(fullPath, "/home/cutie/") && fullPath != "/home/cutie" {
		return "", fmt.Errorf("static path must be within /home/cutie (got: %s)", fullPath)
	}

	// Check if directory exists
	info, err := os.Stat(fullPath)
	if err != nil {
		return "", fmt.Errorf("static directory not found: %s", fullPath)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("static path is not a directory: %s", fullPath)
	}

	return fullPath, nil
}

func getShell() string {
	if runtime.GOOS == "windows" {
		if comspec := os.Getenv("COMSPEC"); comspec != "" {
			return comspec
		}
		return "cmd.exe"
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/bash"
}

func (s *ptySession) close() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return
	}
	s.closed = true

	if s.ptmx != nil {
		s.ptmx.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
}

// serveErrorPage serves a beautiful error page
func serveErrorPage(w http.ResponseWriter, title, message, details string) {
	w.WriteHeader(http.StatusInternalServerError)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	html := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>%s - Cute Computer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #ffeef8 0%%, #e0d4f7 100%%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 600px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
        }
        h1 {
            color: #d946ef;
            font-size: 28px;
            margin-bottom: 20px;
        }
        .message {
            color: #6b7280;
            font-size: 16px;
            line-height: 1.6;
            margin-bottom: 20px;
        }
        .details {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            border-radius: 5px;
            font-family: monospace;
            font-size: 14px;
            color: #92400e;
            white-space: pre-wrap;
            word-break: break-word;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>%s</h1>
        <div class="message">%s</div>
        %s
    </div>
</body>
</html>`, title, title, message, details)

	w.Write([]byte(html))
}

// serve404 serves a 404 error page
func serve404(w http.ResponseWriter, path string) {
	w.WriteHeader(http.StatusNotFound)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	html := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 Not Found - Cute Computer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #ffeef8 0%%, #e0d4f7 100%%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 600px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
            text-align: center;
        }
        h1 {
            color: #d946ef;
            font-size: 72px;
            margin-bottom: 20px;
        }
        h2 {
            color: #6b7280;
            font-size: 24px;
            margin-bottom: 20px;
        }
        .path {
            background: #f3f4f6;
            padding: 10px 15px;
            border-radius: 8px;
            font-family: monospace;
            color: #374151;
            margin: 20px 0;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>404</h1>
        <h2>File Not Found</h2>
        <div class="path">%s</div>
        <p style="color: #6b7280; margin-top: 20px;">The file you're looking for doesn't exist.</p>
    </div>
</body>
</html>`, path)

	w.Write([]byte(html))
}

// handleAPIFilesList lists files in a directory
func handleAPIFilesList(w http.ResponseWriter, r *http.Request) {
	// Get path from query parameter (default to root)
	queryPath := r.URL.Query().Get("path")
	if queryPath == "" {
		queryPath = ""
	}

	// Validate and resolve path
	absPath, err := validateAndResolvePath(queryPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Check if directory exists
	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Directory not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if !info.IsDir() {
		http.Error(w, "Path is not a directory", http.StatusBadRequest)
		return
	}

	// Walk directory tree recursively
	var files []FileInfo
	err = filepath.Walk(absPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip the root directory itself
		if path == absPath {
			return nil
		}

		relPath := toRelativePath(path)
		files = append(files, FileInfo{
			Path:  relPath,
			Name:  info.Name(),
			IsDir: info.IsDir(),
			Size:  info.Size(),
		})

		return nil
	})

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Return JSON response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(files)
}

// handleAPIFilesGet reads a file's content
func handleAPIFilesGet(w http.ResponseWriter, r *http.Request, filePath string) {
	// Validate and resolve path
	absPath, err := validateAndResolvePath(filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Check if file exists
	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Don't serve directories as file content
	if info.IsDir() {
		http.Error(w, "Path is a directory", http.StatusBadRequest)
		return
	}

	// Read file content
	content, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Detect MIME type
	mimeType := mime.TypeByExtension(filepath.Ext(absPath))
	if mimeType == "" {
		mimeType = "text/plain"
	}

	// Return file content
	w.Header().Set("Content-Type", mimeType)
	w.Write(content)
}

// handleAPIFilesPut creates or updates a file
func handleAPIFilesPut(w http.ResponseWriter, r *http.Request, filePath string) {
	// Validate and resolve path
	absPath, err := validateAndResolvePath(filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Read request body
	content, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	// Create parent directories if needed
	parentDir := filepath.Dir(absPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		http.Error(w, fmt.Sprintf("Failed to create parent directories: %v", err), http.StatusInternalServerError)
		return
	}

	// Write file
	if err := os.WriteFile(absPath, content, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// handleAPIFilesDelete deletes a file
func handleAPIFilesDelete(w http.ResponseWriter, r *http.Request, filePath string) {
	// Validate and resolve path
	absPath, err := validateAndResolvePath(filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Delete file
	if err := os.Remove(absPath); err != nil {
		if os.IsNotExist(err) {
			// 404 is acceptable for delete
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, fmt.Sprintf("Failed to delete file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// handleAPIFilesMove moves or renames a file
func handleAPIFilesMove(w http.ResponseWriter, r *http.Request) {
	// Parse JSON request body
	var req MoveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON request", http.StatusBadRequest)
		return
	}

	// Validate paths
	fromPath, err := validateAndResolvePath(req.From)
	if err != nil {
		http.Error(w, fmt.Sprintf("Invalid source path: %v", err), http.StatusBadRequest)
		return
	}

	toPath, err := validateAndResolvePath(req.To)
	if err != nil {
		http.Error(w, fmt.Sprintf("Invalid destination path: %v", err), http.StatusBadRequest)
		return
	}

	// Check source exists
	if _, err := os.Stat(fromPath); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Source file not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Create parent directory of destination if needed
	toParent := filepath.Dir(toPath)
	if err := os.MkdirAll(toParent, 0755); err != nil {
		http.Error(w, fmt.Sprintf("Failed to create destination directory: %v", err), http.StatusInternalServerError)
		return
	}

	// Move/rename file
	if err := os.Rename(fromPath, toPath); err != nil {
		http.Error(w, fmt.Sprintf("Failed to move file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
	written    int64
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.written += int64(n)
	return n, err
}

// formatBytes converts bytes to human-readable format
func formatBytes(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// formatDuration converts duration to human-readable format
func formatDuration(d time.Duration) string {
	if d < time.Microsecond {
		return fmt.Sprintf("%dns", d.Nanoseconds())
	}
	if d < time.Millisecond {
		return fmt.Sprintf("%.2fµs", float64(d.Nanoseconds())/1000.0)
	}
	if d < time.Second {
		return fmt.Sprintf("%.2fms", float64(d.Microseconds())/1000.0)
	}
	return fmt.Sprintf("%.2fs", d.Seconds())
}

// logRequest logs HTTP request with beautiful formatting
func logRequest(method, path string, status int, duration time.Duration, size int64) {
	statusText := http.StatusText(status)
	durationStr := formatDuration(duration)
	sizeStr := formatBytes(size)

	// Format: GET /index.html -> 200 OK (2.45ms, 1.2 KB)
	logMsg := fmt.Sprintf("%s %s -> %d %s (%s, %s)",
		method, path, status, statusText, durationStr, sizeStr)

	writeLog(logMsg)
}

// handleHTTP serves static files based on config
func handleHTTP(w http.ResponseWriter, r *http.Request) {
	// Track request timing
	startTime := time.Now()

	// Wrap response writer to capture status and size
	rw := &responseWriter{
		ResponseWriter: w,
		statusCode:     200, // Default to 200
		written:        0,
	}

	// Defer logging until after response is sent
	defer func() {
		duration := time.Since(startTime)
		logRequest(r.Method, r.URL.Path, rw.statusCode, duration, rw.written)
	}()
	// Only serve GET and HEAD requests
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(rw, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Load config
	config, err := loadConfig()
	if err != nil {
		details := fmt.Sprintf(`<div class="details">%s</div>`, err.Error())
		serveErrorPage(rw, "Configuration Error",
			"There was a problem loading your config file. Please check the syntax and try again.",
			details)
		return
	}

	// Resolve static directory
	staticDir, err := resolveStaticPath(config.Static)
	if err != nil {
		details := fmt.Sprintf(`<div class="details">%s

Configured path: %s</div>`, err.Error(), config.Static)
		serveErrorPage(rw, "Static Directory Error",
			"The configured static directory could not be found or accessed.",
			details)
		return
	}

	// Clean the request path
	requestPath := filepath.Clean(r.URL.Path)
	if requestPath == "/" {
		requestPath = "/index.html"
	}

	// Remove leading slash for filepath.Join
	requestPath = strings.TrimPrefix(requestPath, "/")

	// Build full file path
	fullPath := filepath.Join(staticDir, requestPath)

	// Security: ensure the resolved path is still within staticDir
	if !strings.HasPrefix(fullPath, staticDir) {
		serve404(rw, r.URL.Path)
		return
	}

	// Check if file exists
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			serve404(rw, r.URL.Path)
			return
		}
		http.Error(rw, "Internal server error", http.StatusInternalServerError)
		return
	}

	// If it's a directory, try to serve index.html
	if info.IsDir() {
		indexPath := filepath.Join(fullPath, "index.html")
		if _, err := os.Stat(indexPath); err == nil {
			fullPath = indexPath
		} else {
			serve404(rw, r.URL.Path)
			return
		}
	}

	// Read file
	content, err := os.ReadFile(fullPath)
	if err != nil {
		http.Error(rw, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Detect MIME type
	mimeType := mime.TypeByExtension(filepath.Ext(fullPath))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	// Set headers
	rw.Header().Set("Content-Type", mimeType)
	rw.Header().Set("Content-Length", strconv.Itoa(len(content)))

	// Write content
	rw.Write(content)
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Parse query params
	cols := 80
	rows := 24
	computerName := r.URL.Query().Get("name")
	if computerName == "" {
		computerName = "default"
	}

	if colsStr := r.URL.Query().Get("cols"); colsStr != "" {
		if c, err := strconv.Atoi(colsStr); err == nil {
			cols = c
		}
	}
	if rowsStr := r.URL.Query().Get("rows"); rowsStr != "" {
		if r, err := strconv.Atoi(rowsStr); err == nil {
			rows = r
		}
	}

	// Upgrade to WebSocket
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer ws.Close()

	// Set up pong handler
	ws.SetReadDeadline(time.Now().Add(pongWait))
	ws.SetPongHandler(func(string) error {
		ws.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Create shell command as cutie user
	shell := getShell()

	// Set PS1 with computer name - use raw escape codes
	ps1 := fmt.Sprintf("\\[\\e[1;35m\\]%s\\[\\e[0m\\]:\\[\\e[1;36m\\]\\w\\[\\e[0m\\]\\$ ", computerName)

	// Use bash with --norc --noprofile to prevent PS1 override
	cmd := exec.Command(shell, "--norc", "--noprofile")

	// Set user to cutie (UID 1000 is typically the first non-root user created)
	// cmd.SysProcAttr = &syscall.SysProcAttr{
	// 	Credential: &syscall.Credential{
	// 		Uid: 1000, // cutie user
	// 		Gid: 1000, // cutie group
	// 	},
	// }

	// Start in cutie's home directory
	cmd.Dir = "/home/cutie"

	cmd.Env = []string{
		"HOME=/home/cutie",
		"USER=cutie",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		fmt.Sprintf("PS1=%s", ps1),
		"ENV=", // Disable any ENV file loading
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}

	// Start PTY
	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Printf("Failed to start PTY: %v", err)
		return
	}

	session := &ptySession{
		cmd:  cmd,
		ptmx: ptmx,
		ws:   ws,
	}
	defer session.close()

	// Set initial size
	if err := pty.Setsize(ptmx, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	}); err != nil {
		log.Printf("Failed to set PTY size: %v", err)
	}

	// Send welcome message with gradient line
	var welcomeMsg strings.Builder
	welcomeMsg.WriteString("\r\n")
	welcomeMsg.WriteString("           Welcome to Cute Computer!  >_<\r\n")
	welcomeMsg.WriteString("           ")

	// Gradient line: pink -> purple -> indigo
	width := 33
	for i := 0; i < width; i++ {
		progress := float64(i) / float64(width-1)

		if progress < 0.5 {
			// Pink to purple
			t := progress * 2
			red := int(251.0 - t*18.0)  // 251 -> 233
			green := int(207.0 + t*6.0) // 207 -> 213
			blue := int(232.0 + t*23.0) // 232 -> 255
			welcomeMsg.WriteString(fmt.Sprintf("\x1b[38;2;%d;%d;%dm─\x1b[0m", red, green, blue))
		} else {
			// Purple to indigo
			t := (progress - 0.5) * 2
			red := int(233.0 - t*34.0)  // 233 -> 199
			green := int(213.0 - t*3.0) // 213 -> 210
			blue := int(255.0 - t*1.0)  // 255 -> 254
			welcomeMsg.WriteString(fmt.Sprintf("\x1b[38;2;%d;%d;%dm─\x1b[0m", red, green, blue))
		}
	}

	welcomeMsg.WriteString("\r\n\r\n")
	ws.WriteMessage(websocket.TextMessage, []byte(welcomeMsg.String()))

	// Start ping ticker to keep connection alive
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	go func() {
		for range ticker.C {
			session.mu.Lock()
			if session.closed {
				session.mu.Unlock()
				return
			}
			if err := ws.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
				log.Printf("Ping error: %v", err)
				session.mu.Unlock()
				return
			}
			session.mu.Unlock()
		}
	}()

	// PTY -> WebSocket (read from PTY, send to browser)
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("PTY read error: %v", err)
				}
				return
			}

			session.mu.Lock()
			if !session.closed {
				if err := ws.WriteMessage(websocket.TextMessage, buf[:n]); err != nil {
					log.Printf("WebSocket write error: %v", err)
					session.mu.Unlock()
					return
				}
			}
			session.mu.Unlock()
		}
	}()

	// WebSocket -> PTY (read from browser, write to PTY)
	for {
		msgType, data, err := ws.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket read error: %v", err)
			}
			break
		}

		if msgType == websocket.TextMessage {
			msg := string(data)

			// Check if it's a resize message
			if len(msg) > 0 && msg[0] == '{' {
				var resize resizeMessage
				if err := json.Unmarshal(data, &resize); err == nil && resize.Type == "resize" {
					if err := pty.Setsize(ptmx, &pty.Winsize{
						Rows: resize.Rows,
						Cols: resize.Cols,
					}); err != nil {
						log.Printf("Failed to resize PTY: %v", err)
					}
					continue
				}
			}

			// Regular input - write to PTY
			if _, err := ptmx.Write(data); err != nil {
				log.Printf("PTY write error: %v", err)
				break
			}
		}
	}

	// Wait for command to finish
	cmd.Wait()
}

func main() {

	loc := os.Getenv("CLOUDFLARE_LOCATION")

	// Don't mount fuse in local docker
	if loc != "" && loc != "loc01" {
		// Get Durable Object ID to use as S3 bucket name for isolation
		doID := os.Getenv("CLOUDFLARE_DURABLE_OBJECT_ID")
		if doID == "" {
			log.Fatalf("CLOUDFLARE_DURABLE_OBJECT_ID not set")
		}
		log.Printf("Using Durable Object ID as S3 bucket: %s", doID)

		// Get S3 auth token
		s3Token := os.Getenv("S3_AUTH_TOKEN")
		if s3Token == "" {
			log.Fatalf("S3_AUTH_TOKEN not set")
		}

		// Create mount point directory
		if err := os.MkdirAll("/home/cutie", 0755); err != nil {
			log.Fatalf("Failed to create directory: %v", err)
		}

		bucket := fmt.Sprintf("s3-%s", doID)

		// os.Stat("/home/cutie")

		go func() {
			// Use Durable Object ID as the S3 bucket name for per-computer isolation
			cmd := exec.Command("/usr/local/bin/tigrisfs",
				"--endpoint", "https://cute.maxmcd.com/",
				"-f",
				bucket,
				"/home/cutie")
			// Pass JWT token as AWS access key ID
			// tigrisfs will include this in the Authorization header's Credential field
			// Format: "AWS4-HMAC-SHA256 Credential=<jwt>/20231201/auto/s3/aws4_request, ..."
			// Our S3 DO extracts the JWT from the Credential field
			cmd.Env = append(os.Environ(),
				"AWS_ACCESS_KEY_ID="+s3Token,
				"AWS_SECRET_ACCESS_KEY=not-used", // Required by tigrisfs but ignored by S3 DO
			)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr

			if err := cmd.Run(); err != nil {
				log.Fatalf("tigrisfs failed: %v", err)
			}
			log.Fatalf("tigrisfs exited unexpectedly")
		}()

		// Wait for FUSE mount to be ready before proceeding
		log.Printf("Waiting for FUSE mount at /home/cutie...")
		if err := waitForMount("/home/cutie", 10*time.Second); err != nil {
			log.Fatalf("Failed to wait for mount: %v", err)
		}
	}

	// Ensure config file exists with defaults
	if err := ensureConfigExists(); err != nil {
		log.Printf("Warning: Failed to ensure config exists: %v", err)
	}

	// WebSocket endpoint for PTY
	http.HandleFunc("/ws", handleWebSocket)

	// File API endpoints
	http.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "GET":
			handleAPIFilesList(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	http.HandleFunc("/api/files/", func(w http.ResponseWriter, r *http.Request) {
		// Extract file path from URL
		filePath := strings.TrimPrefix(r.URL.Path, "/api/files/")

		switch r.Method {
		case "GET":
			handleAPIFilesGet(w, r, filePath)
		case "PUT":
			handleAPIFilesPut(w, r, filePath)
		case "DELETE":
			handleAPIFilesDelete(w, r, filePath)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	http.HandleFunc("/api/files/move", handleAPIFilesMove)

	// All other requests go to static file handler
	http.HandleFunc("/", handleHTTP)

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Println("\n\nShutting down...")
		os.Exit(0)
	}()

	port := 8283

	fmt.Printf("Server running at http://0.0.0.0:%d\n", port)

	writeLog("Container started successfully")
	writeLog(fmt.Sprintf("Server listening on port %d", port))

	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
