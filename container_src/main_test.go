package main

import (
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestStaticFileServing(t *testing.T) {
	tests := []struct {
		name     string
		config   string            // config file content (JSON/JSONC)
		files    map[string]string // path -> content
		requests []testRequest
	}{
		{
			name:   "basic index.html serving",
			config: `{"static": "."}`,
			files: map[string]string{
				"index.html": "<h1>Hello</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 200, wantBody: "<h1>Hello</h1>", wantContentType: "text/html"},
				{path: "/index.html", wantStatus: 200, wantBody: "<h1>Hello</h1>"},
			},
		},
		{
			name:   "nested directory structure",
			config: `{"static": "."}`,
			files: map[string]string{
				"index.html":       "<h1>Home</h1>",
				"about/index.html": "<h1>About</h1>",
				"css/style.css":    "body { color: red; }",
				"js/app.js":        "console.log('hi');",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 200, wantBody: "<h1>Home</h1>"},
				{path: "/about/index.html", wantStatus: 200, wantBody: "<h1>About</h1>"},
				{path: "/css/style.css", wantStatus: 200, wantBody: "body { color: red; }", wantContentType: "text/css"},
				{path: "/js/app.js", wantStatus: 200, wantBody: "console.log('hi');", wantContentType: "text/javascript"},
				{path: "/missing.html", wantStatus: 404},
			},
		},
		{
			name:   "subdirectory static root",
			config: `{"static": "public"}`,
			files: map[string]string{
				"public/index.html": "<h1>Public Site</h1>",
				"public/app.js":     "alert('hi');",
				"index.html":        "<h1>Root - Should not be served</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 200, wantBody: "<h1>Public Site</h1>"},
				{path: "/index.html", wantStatus: 200, wantBody: "<h1>Public Site</h1>"},
				{path: "/app.js", wantStatus: 200, wantBody: "alert('hi');"},
			},
		},
		{
			name:   "path traversal prevention",
			config: `{"static": "public"}`,
			files: map[string]string{
				"public/index.html": "<h1>Public</h1>",
				"secret.txt":        "secret data",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 200, wantBody: "<h1>Public</h1>"},
				{path: "/../secret.txt", wantStatus: 404},
				{path: "/../../secret.txt", wantStatus: 404},
				{path: "/./../secret.txt", wantStatus: 404},
			},
		},
		{
			name:   "404 handling",
			config: `{"static": "."}`,
			files: map[string]string{
				"index.html": "<h1>Home</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 200},
				{path: "/missing.html", wantStatus: 404, wantBodyContains: "404"},
				{path: "/deeply/nested/missing.html", wantStatus: 404},
			},
		},
		{
			name:   "MIME type detection",
			config: `{"static": "."}`,
			files: map[string]string{
				"index.html":   "<h1>HTML</h1>",
				"s3/index.txt": "foo",
				"style.css":    "body {}",
				"app.js":       "console.log('js');",
				"data.json":    `{"key": "value"}`,
				"image.svg":    "<svg></svg>",
				"doc.pdf":      "fake pdf",
				"video.mp4":    "fake video",
				"file.bin":     "binary data",
			},
			requests: []testRequest{
				{path: "/index.html", wantStatus: 200, wantContentType: "text/html"},
				{path: "/s3/index.txt", wantStatus: 200, wantContentType: "text/plain"},
				{path: "/style.css", wantStatus: 200, wantContentType: "text/css"},
				{path: "/app.js", wantStatus: 200, wantContentType: "text/javascript"},
				{path: "/data.json", wantStatus: 200, wantContentType: "application/json"},
				{path: "/image.svg", wantStatus: 200, wantContentType: "image/svg+xml"},
				{path: "/doc.pdf", wantStatus: 200, wantContentType: "application/pdf"},
				{path: "/video.mp4", wantStatus: 200, wantContentType: "video/mp4"},
				{path: "/file.bin", wantStatus: 200, wantContentType: "application/octet-stream"},
			},
		},
		{
			name: "JSONC config with comments",
			config: `{
				// This is a comment
				"static": "dist" // inline comment
				/* block comment */
			}`,
			files: map[string]string{
				"dist/index.html": "<h1>From dist</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 200, wantBody: "<h1>From dist</h1>"},
			},
		},
		{
			name:   "HEAD request support",
			config: `{"static": "."}`,
			files: map[string]string{
				"index.html": "<h1>Hello</h1>",
				"large.txt":  strings.Repeat("x", 10000),
			},
			requests: []testRequest{
				{method: "HEAD", path: "/index.html", wantStatus: 200, wantBody: "", wantContentLength: 14},
				{method: "HEAD", path: "/large.txt", wantStatus: 200, wantBody: "", wantContentLength: 10000},
				{method: "HEAD", path: "/missing.html", wantStatus: 404},
			},
		},
		{
			name:   "method filtering",
			config: `{"static": "."}`,
			files: map[string]string{
				"index.html": "<h1>Hello</h1>",
			},
			requests: []testRequest{
				{method: "GET", path: "/", wantStatus: 200},
				{method: "POST", path: "/", wantStatus: 405},
				{method: "PUT", path: "/", wantStatus: 405},
				{method: "DELETE", path: "/", wantStatus: 405},
				{method: "PATCH", path: "/", wantStatus: 405},
			},
		},
		{
			name:   "empty config static field",
			config: `{"static": ""}`,
			files: map[string]string{
				"index.html": "<h1>Hello</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 500, wantBodyContains: "Configuration Error"},
			},
		},
		{
			name:   "invalid JSON config",
			config: `{"static": ".", invalid}`,
			files: map[string]string{
				"index.html": "<h1>Hello</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 500, wantBodyContains: "Configuration Error"},
			},
		},
		{
			name:   "missing static directory",
			config: `{"static": "nonexistent"}`,
			files: map[string]string{
				"index.html": "<h1>Hello</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 500, wantBodyContains: "Static Directory Error"},
			},
		},
		{
			name:   "path cleaning and normalization",
			config: `{"static": "."}`,
			files: map[string]string{
				"index.html": "<h1>Home</h1>",
				"page.html":  "<h1>Page</h1>",
			},
			requests: []testRequest{
				{path: "/", wantStatus: 200, wantBody: "<h1>Home</h1>"},
				{path: "//", wantStatus: 200, wantBody: "<h1>Home</h1>"},
				{path: "/./index.html", wantStatus: 200, wantBody: "<h1>Home</h1>"},
				{path: "/page.html", wantStatus: 200, wantBody: "<h1>Page</h1>"},
				{path: "//page.html", wantStatus: 200, wantBody: "<h1>Page</h1>"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Setup: Create temp directory structure
			tmpDir := t.TempDir()
			cutieHome := filepath.Join(tmpDir, "home", "cutie")
			if err := os.MkdirAll(cutieHome, 0755); err != nil {
				t.Fatal(err)
			}

			// Write config file
			configPath := filepath.Join(cutieHome, "config.json")
			if err := os.WriteFile(configPath, []byte(tt.config), 0644); err != nil {
				t.Fatal(err)
			}

			// Write all test files
			for path, content := range tt.files {
				fullPath := filepath.Join(cutieHome, path)
				dir := filepath.Dir(fullPath)
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
					t.Fatal(err)
				}
			}

			// Create test HTTP handler that uses the test directory
			handler := createTestHandler(cutieHome)

			// Run all requests for this test case
			for i, req := range tt.requests {
				method := req.method
				if method == "" {
					method = "GET"
				}

				httpReq := httptest.NewRequest(method, req.path, nil)
				w := httptest.NewRecorder()
				handler(w, httpReq)

				resp := w.Result()

				// Check status code
				if resp.StatusCode != req.wantStatus {
					t.Errorf("request %d (%s %s): status = %d, want %d",
						i, method, req.path, resp.StatusCode, req.wantStatus)
				}

				// Check content type if specified
				if req.wantContentType != "" {
					ct := resp.Header.Get("Content-Type")
					if !strings.Contains(ct, req.wantContentType) {
						t.Errorf("request %d (%s %s): content-type = %q, want %q",
							i, method, req.path, ct, req.wantContentType)
					}
				}

				// Check body exact match if specified
				body := w.Body.String()
				if req.wantBody != "" && body != req.wantBody {
					t.Errorf("request %d (%s %s): body = %q, want %q",
						i, method, req.path, body, req.wantBody)
				}

				// Check body contains if specified
				if req.wantBodyContains != "" && !strings.Contains(body, req.wantBodyContains) {
					t.Errorf("request %d (%s %s): body doesn't contain %q, got: %q",
						i, method, req.path, req.wantBodyContains, body)
				}

				// Check content length for HEAD requests
				if req.wantContentLength > 0 {
					cl := resp.Header.Get("Content-Length")
					if cl != strconv.Itoa(req.wantContentLength) {
						t.Errorf("request %d (%s %s): content-length = %q, want %d",
							i, method, req.path, cl, req.wantContentLength)
					}
				}
			}
		})
	}
}

type testRequest struct {
	method            string // defaults to GET
	path              string
	wantStatus        int
	wantContentType   string
	wantBody          string // exact match
	wantBodyContains  string // substring match
	wantContentLength int    // for HEAD requests
}

// createTestHandler creates an HTTP handler for testing that uses a custom base directory
func createTestHandler(baseDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Load config from test directory
		config, err := loadConfigFromDir(baseDir)
		if err != nil {
			details := fmt.Sprintf(`<div class="details">%s</div>`, err.Error())
			serveErrorPage(w, "Configuration Error",
				"There was a problem loading your config file. Please check the syntax and try again.",
				details)
			return
		}

		// Resolve static directory relative to test base
		staticDir, err := resolveStaticPathFromBase(baseDir, config.Static)
		if err != nil {
			details := fmt.Sprintf(`<div class="details">%s

Configured path: %s</div>`, err.Error(), config.Static)
			serveErrorPage(w, "Static Directory Error",
				"The configured static directory could not be found or accessed.",
				details)
			return
		}

		// Clean the request path
		requestPath := filepath.Clean(r.URL.Path)
		if requestPath == "/" {
			requestPath = "/index.html"
		}

		requestPath = strings.TrimPrefix(requestPath, "/")
		fullPath := filepath.Join(staticDir, requestPath)

		// Security: ensure the resolved path is still within staticDir
		if !strings.HasPrefix(fullPath, staticDir) {
			serve404(w, r.URL.Path)
			return
		}

		// Check if file exists
		info, err := os.Stat(fullPath)
		if err != nil {
			if os.IsNotExist(err) {
				serve404(w, r.URL.Path)
				return
			}
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// If it's a directory, try to serve index.html
		if info.IsDir() {
			indexPath := filepath.Join(fullPath, "index.html")
			if _, err := os.Stat(indexPath); err == nil {
				fullPath = indexPath
			} else {
				serve404(w, r.URL.Path)
				return
			}
		}

		// Read file
		content, err := os.ReadFile(fullPath)
		if err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// Detect MIME type
		mimeType := mime.TypeByExtension(filepath.Ext(fullPath))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}

		// Set headers
		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))

		// Write content
		w.Write(content)
	}
}

// loadConfigFromDir loads config from a specific directory
func loadConfigFromDir(baseDir string) (*Config, error) {
	configPath := filepath.Join(baseDir, "config.json")
	if _, err := os.Stat(configPath); err != nil {
		jsonc := filepath.Join(baseDir, "config.jsonc")
		if _, err := os.Stat(jsonc); err != nil {
			return nil, fmt.Errorf("no config file found (tried config.json and config.jsonc)")
		}
		configPath = jsonc
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	data = sanitizeJSONC(data)
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config JSON: %w", err)
	}

	if config.Static == "" {
		return nil, fmt.Errorf("config.static field is required")
	}

	return &config, nil
}

// resolveStaticPathFromBase resolves static path relative to a base directory
func resolveStaticPathFromBase(baseDir, staticPath string) (string, error) {
	var fullPath string
	if filepath.IsAbs(staticPath) {
		fullPath = staticPath
	} else {
		fullPath = filepath.Join(baseDir, staticPath)
	}

	fullPath = filepath.Clean(fullPath)

	// Security: ensure path is within baseDir
	if !strings.HasPrefix(fullPath, baseDir+string(filepath.Separator)) && fullPath != baseDir {
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
