package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

//go:embed index.html
var indexHTML []byte

//go:embed node_modules/ghostty-web/dist
var distFS embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins for development
		// In production, you should validate the origin
		return true
	},
}

type ptySession struct {
	cmd    *exec.Cmd
	ptmx   *os.File
	ws     *websocket.Conn
	mu     sync.Mutex
	closed bool
}

type resizeMessage struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
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

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Parse cols and rows from query params
	cols := 80
	rows := 24
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

	// Create shell command
	shell := getShell()
	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)

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

	// Send welcome message
	welcomeMsg := "\x1b[1;36m╔══════════════════════════════════════════════════════════════╗\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m  \x1b[1;32mWelcome to ghostty-web!\x1b[0m                                     \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m                                                              \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m  You have a real shell session with full PTY support.        \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m  Try: \x1b[1;33mls\x1b[0m, \x1b[1;33mcd\x1b[0m, \x1b[1;33mtop\x1b[0m, \x1b[1;33mvim\x1b[0m, or any command!                      \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m╚══════════════════════════════════════════════════════════════╝\x1b[0m\r\n\r\n"
	ws.WriteMessage(websocket.TextMessage, []byte(welcomeMsg))

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
		if err := os.MkdirAll("/opt/s3", 0755); err != nil {
			log.Fatalf("Failed to create directory: %v", err)
		}
		cmd := exec.Command("/usr/local/bin/tigrisfs", "--endpoint", "https://s3do.maxm.workers.dev/", "-f", "foo", "/opt/s3")
		cmd.Env = append(os.Environ(),
			"AWS_ACCESS_KEY_ID=foo",
			"AWS_SECRET_ACCESS_KEY=bar",
		)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		if err := cmd.Start(); err != nil {
			log.Fatalf("Failed to start tigrisfs: %v", err)
		}
	}

	// WebSocket endpoint for PTY
	http.HandleFunc("/ws", handleWebSocket)

	http.HandleFunc("/____container", func(w http.ResponseWriter, r *http.Request) {
		if err := os.WriteFile("/opt/s3/test.txt", []byte("Hello World!"), 0644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		entries, err := os.ReadDir("/opt/s3")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		names := make([]string, len(entries))
		for i, entry := range entries {
			names[i] = entry.Name()
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(names)
	})

	// Serve the ghostty-web dist folder from embedded files
	distSubFS, err := fs.Sub(distFS, "node_modules/ghostty-web/dist")
	if err != nil {
		log.Fatalf("Failed to create sub filesystem: %v", err)
	}
	http.Handle("/dist/", http.StripPrefix("/dist/", http.FileServer(http.FS(distSubFS))))

	// Serve index.html at root from embedded file
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})

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

	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
