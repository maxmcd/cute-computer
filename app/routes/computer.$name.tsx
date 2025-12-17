import { useEffect, useRef, useState } from "react";

export function meta({ params }: any) {
  return [
    { title: `${params.name} - Cute Computer` },
    { name: "description", content: "" },
  ];
}

export default function Computer({ params }: any) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [statusText, setStatusText] = useState("Connecting...");
  const [reconnectMessage, setReconnectMessage] = useState("");
  const [subdomainUrl, setSubdomainUrl] = useState("");

  const computerName = params.name;

  useEffect(() => {
    // Set subdomain URL on client side only
    if (typeof window !== "undefined") {
      setSubdomainUrl(`http://${computerName}.${window.location.host}`);
    }

    let mounted = true;

    async function initTerminal() {
      if (!containerRef.current) return;

      // Dynamic import ghostty-web
      const { init, Terminal, FitAddon } = await import("ghostty-web");

      if (!mounted) return;

      await init();

      const term = new Terminal({
        cols: 80,
        rows: 24,
        fontFamily: "JetBrains Mono, Menlo, Monaco, monospace",
        fontSize: 14,
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      await term.open(containerRef.current);
      fitAddon.fit();
      fitAddon.observeResize();

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

      // Connect to WebSocket
      function connect() {
        setStatus("connecting");
        setStatusText("Connecting...");

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/ws?name=${encodeURIComponent(computerName)}&cols=${term.cols}&rows=${term.rows}`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setStatus("connected");
          setStatusText("Connected");
          setReconnectMessage("");
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onclose = () => {
          setStatus("disconnected");
          setStatusText("Disconnected");
          setReconnectMessage("Reconnecting in 2s...");
          setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          setStatus("disconnected");
          setStatusText("Error");
        };

        wsRef.current = ws;
      }

      connect();

      // Send terminal input to server
      term.onData((data: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });

      // Handle resize - notify PTY when terminal dimensions change
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      // Debounce function for resize events
      let resizeTimeout: ReturnType<typeof setTimeout>;
      function debouncedFit() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          fitAddon.fit();
        }, 50);
      }

      // Handle window resize
      window.addEventListener("resize", debouncedFit);

      // Use ResizeObserver for more reliable resize detection
      const resizeObserver = new ResizeObserver(debouncedFit);
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      // Handle mobile keyboard showing/hiding using visualViewport API
      if (window.visualViewport) {
        const terminalContent = containerRef.current;
        const terminalWindow = terminalContent?.closest(
          ".terminal-window"
        ) as HTMLElement;
        const body = document.body;

        let viewportResizeTimeout: ReturnType<typeof setTimeout>;
        window.visualViewport.addEventListener("resize", () => {
          const keyboardHeight =
            window.innerHeight - window.visualViewport!.height;
          if (keyboardHeight > 100) {
            body.style.padding = "0";
            body.style.alignItems = "flex-start";
            if (terminalWindow) {
              terminalWindow.style.borderRadius = "0";
              terminalWindow.style.maxWidth = "100%";
            }
            if (terminalContent) {
              terminalContent.style.height = `${window.visualViewport!.height - 60}px`;
            }
            window.scrollTo(0, 0);
          } else {
            body.style.padding = "40px 20px";
            body.style.alignItems = "center";
            if (terminalWindow) {
              terminalWindow.style.borderRadius = "12px";
              terminalWindow.style.maxWidth = "1000px";
            }
            if (terminalContent) {
              terminalContent.style.height = "600px";
            }
          }

          // Debounced fit for viewport changes
          clearTimeout(viewportResizeTimeout);
          viewportResizeTimeout = setTimeout(() => {
            fitAddon.fit();
          }, 100);
        });
      }

      // Cleanup
      return () => {
        mounted = false;
        if (wsRef.current) {
          wsRef.current.close();
        }
        if (terminalRef.current) {
          terminalRef.current.dispose();
        }
      };
    }

    initTerminal();

    return () => {
      mounted = false;
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div className="min-h-screen w-full flex flex-col bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-300">
      <style>{`
        body {
          background: linear-gradient(135deg, #fbcfe8 0%, #e9d5ff 50%, #c7d2fe 100%);
          margin: 0;
        }
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
        .animate-pulse-dot {
          animation: pulse 1s infinite;
        }
      `}</style>

      {/* Header with Logo at top */}
      <div className="w-full px-10 md:px-5 py-6">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <a
            href="/"
            className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          >
            <span className="text-2xl text-purple-900 font-mono">
              &gt;_&lt;
            </span>
            <h1 className="text-2xl font-bold text-purple-900">
              Cute Computer
            </h1>
          </a>

          {/* Subdomain Link */}
          {subdomainUrl && (
            <a
              href={subdomainUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white/90 hover:bg-white rounded-lg shadow-md hover:shadow-lg transition-all text-purple-700 font-medium text-sm"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
              Open {subdomainUrl.replace("http://", "")}
            </a>
          )}
        </div>
      </div>

      {/* Terminal centered in remaining space */}
      <div className="flex-1 flex items-center justify-center px-10 md:px-5 pb-10">
        <div className="terminal-window w-full max-w-4xl bg-[#1e1e1e] rounded-xl shadow-2xl overflow-hidden">
          {/* Title Bar */}
          <div className="bg-gradient-to-r from-pink-300 to-purple-300 px-4 py-3 flex items-center gap-3 border-b border-purple-400">
            {/* Traffic Lights */}
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full bg-pink-400"></div>
              <div className="w-3 h-3 rounded-full bg-purple-400"></div>
              <div className="w-3 h-3 rounded-full bg-indigo-400"></div>
            </div>

            {/* Title */}
            <span className="flex-1 text-center text-purple-900 text-[13px] font-medium tracking-wide">
              {computerName}
              {reconnectMessage && (
                <span className="text-pink-600 text-xs ml-4">
                  {reconnectMessage}
                </span>
              )}
            </span>

            {/* Connection Status */}
            <div className="ml-auto flex items-center gap-1.5 text-[11px] text-purple-700">
              <div
                className={`w-2 h-2 rounded-full ${
                  status === "connected"
                    ? "bg-green-400"
                    : status === "disconnected"
                      ? "bg-pink-400"
                      : "bg-purple-400 animate-pulse-dot"
                }`}
              ></div>
              <span>{statusText}</span>
            </div>
          </div>

          {/* Terminal Content */}
          <div
            ref={containerRef}
            className="h-[600px] md:h-[500px] p-4 bg-[#1e1e1e] relative overflow-hidden"
          ></div>
        </div>
      </div>
    </div>
  );
}
