import { useEffect, useRef, useState } from "react";
import { FileTree } from "../components/FileTree";
import { CodeEditor } from "../components/CodeEditor";
import {
  fetchDurableObjectId,
  listS3Objects,
  getS3Object,
  putS3Object,
} from "../lib/s3";
import { buildFileTree, sortTreeNodes, detectLanguage } from "../lib/file-tree";
import type { TreeNode } from "../lib/file-tree";

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
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [statusText, setStatusText] = useState("Connecting...");
  const [reconnectMessage, setReconnectMessage] = useState("");
  const [subdomainUrl, setSubdomainUrl] = useState("");

  // Editor state
  const [doId, setDoId] = useState<string>("");
  const [fileTree, setFileTree] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingFileContent, setLoadingFileContent] = useState(false);
  const [editorError, setEditorError] = useState<string>("");

  // File content cache - keep last 10 files in memory
  const fileCacheRef = useRef<Map<string, string>>(new Map());

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
        cursorBlink: true,
        cursorStyle: "block",
        theme: {
          background: "#ffffff",
          foreground: "#1f2937",
          cursor: "#ec489960",
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

  // Initialize editor: fetch DO ID and load file tree
  useEffect(() => {
    async function initEditor() {
      try {
        setLoadingFiles(true);
        setEditorError("");

        // Get Durable Object ID
        const id = await fetchDurableObjectId(computerName);
        setDoId(id);

        // List all files (no prefix needed)
        const objects = await listS3Objects(id, "");
        const keys = objects.map((obj) => obj.key);

        // Build and sort tree
        const tree = buildFileTree(keys);
        const sortedTree = sortTreeNodes(tree);
        setFileTree(sortedTree);
      } catch (error) {
        console.error("Failed to initialize editor:", error);
        setEditorError(
          error instanceof Error ? error.message : "Failed to load files"
        );
      } finally {
        setLoadingFiles(false);
      }
    }

    initEditor();
  }, [computerName]);

  // Note: File loading now happens in handleFileSelect before selectedFile changes
  // This ensures content is always ready when selectedFile updates

  // Handle file content changes
  const handleContentChange = (newContent: string) => {
    setFileContent(newContent);
    setIsDirty(newContent !== originalContent);
  };

  // Save file to S3
  const handleSave = async () => {
    if (!selectedFile || !doId || !isDirty) return;

    try {
      setIsSaving(true);
      setEditorError("");
      await putS3Object(doId, selectedFile, fileContent);
      setOriginalContent(fileContent);
      setIsDirty(false);
      // Update cache with saved content
      fileCacheRef.current.set(selectedFile, fileContent);
    } catch (error) {
      console.error("Failed to save file:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to save file"
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Auto-save on interval (500ms after last change)
  useEffect(() => {
    if (!selectedFile || !doId || !isDirty) return;

    const autoSaveTimer = setTimeout(async () => {
      try {
        setIsSaving(true);
        await putS3Object(doId, selectedFile, fileContent);
        setOriginalContent(fileContent);
        setIsDirty(false);
        // Update cache with saved content
        fileCacheRef.current.set(selectedFile, fileContent);
      } catch (error) {
        console.error("Auto-save failed:", error);
      } finally {
        setIsSaving(false);
      }
    }, 500); // 500ms delay after last change

    return () => clearTimeout(autoSaveTimer);
  }, [fileContent, selectedFile, doId, isDirty]);

  // Handle file selection from tree
  const handleFileSelect = async (filePath: string) => {
    if (!doId) return;

    // Auto-save current file before switching
    if (isDirty && selectedFile && doId) {
      try {
        await putS3Object(doId, selectedFile, fileContent);
        setOriginalContent(fileContent);
        setIsDirty(false);
        // Update cache with saved content
        fileCacheRef.current.set(selectedFile, fileContent);
      } catch (error) {
        console.error("Failed to auto-save before switching files:", error);
      }
    }

    // Load new file content FIRST (before changing selectedFile)
    try {
      setEditorError("");

      // Check cache first
      const cached = fileCacheRef.current.get(filePath);
      if (cached !== undefined) {
        // Cache hit - load instantly
        setFileContent(cached);
        setOriginalContent(cached);
        setIsDirty(false);
        setLoadingFileContent(false);
      } else {
        // Cache miss - fetch from S3
        setLoadingFileContent(true);
        const content = await getS3Object(doId, filePath);

        // Update cache (LRU: if cache is full, remove oldest entry)
        if (fileCacheRef.current.size >= 10) {
          const firstKey = fileCacheRef.current.keys().next().value;
          if (firstKey) {
            fileCacheRef.current.delete(firstKey);
          }
        }
        fileCacheRef.current.set(filePath, content);

        setFileContent(content);
        setOriginalContent(content);
        setIsDirty(false);
        setLoadingFileContent(false);
      }
    } catch (error) {
      console.error("Failed to load file:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to load file"
      );
      setLoadingFileContent(false);
      return; // Don't change selected file if loading failed
    }

    // THEN change selected file (content is guaranteed to be ready)
    setSelectedFile(filePath);
  };

  // Refresh file tree
  const refreshFileTree = async () => {
    if (!doId) return;

    try {
      setLoadingFiles(true);
      const objects = await listS3Objects(doId, "");
      const keys = objects.map((obj) => obj.key);
      const tree = buildFileTree(keys);
      const sortedTree = sortTreeNodes(tree);
      setFileTree(sortedTree);
    } catch (error) {
      console.error("Failed to refresh file tree:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to refresh files"
      );
    } finally {
      setLoadingFiles(false);
    }
  };

  // Create new file
  const handleCreateFile = async () => {
    if (!doId) return;

    const fileName = window.prompt("Enter file name (e.g., script.js):");
    if (!fileName) return;

    // Remove leading slash if present
    const cleanFileName = fileName.replace(/^\/+/, "");

    try {
      setEditorError("");
      // Create empty file
      await putS3Object(doId, cleanFileName, "");
      await refreshFileTree();
      // Auto-select the new file
      setSelectedFile(cleanFileName);
    } catch (error) {
      console.error("Failed to create file:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to create file"
      );
    }
  };

  // Create new folder
  const handleCreateFolder = async () => {
    if (!doId) return;

    const folderName = window.prompt("Enter folder name (e.g., src):");
    if (!folderName) return;

    // Remove leading/trailing slashes and add trailing slash for folder
    const cleanFolderName = folderName.replace(/^\/+|\/+$/g, "");
    const folderPath = `${cleanFolderName}/`;

    try {
      setEditorError("");
      // Create empty S3 object with trailing slash to represent folder
      await putS3Object(doId, folderPath, "");
      await refreshFileTree();
    } catch (error) {
      console.error("Failed to create folder:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to create folder"
      );
    }
  };

  // Detect language from selected file
  const currentLanguage = selectedFile ? detectLanguage(selectedFile) : "text";
  const fileName = selectedFile
    ? selectedFile.split("/").pop() || "No file selected"
    : "No file selected";

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
      <div className="flex items-center justify-center px-10 md:px-5 pb-5">
        <div className="terminal-window w-full max-w-4xl bg-white rounded-xl shadow-2xl overflow-hidden">
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
            className="h-[600px] md:h-[500px] p-4 bg-white relative overflow-hidden"
            style={{
              caretColor: "transparent",
            }}
          ></div>
        </div>
      </div>

      {/* Editor Window */}
      <div className="flex items-start justify-center px-10 md:px-5 pb-10">
        <div className="w-full max-w-4xl bg-white rounded-xl shadow-2xl overflow-hidden">
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
              {fileName}
            </span>

            {/* Save Status */}
            <div className="ml-auto text-xs text-purple-700 font-medium">
              {isSaving ? "Saving..." : isDirty ? "Unsaved" : "Saved"}
            </div>
          </div>

          {/* Editor Content - Split between tree and editor */}
          <div className="flex h-[500px]">
            {/* File Tree - Left Panel */}
            <div className="w-[30%] border-r border-gray-300 overflow-auto">
              {loadingFiles ? (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                  Loading files...
                </div>
              ) : editorError && fileTree.length === 0 ? (
                <div className="flex items-center justify-center h-full text-red-600 text-sm p-4 text-center">
                  {editorError}
                </div>
              ) : fileTree.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm p-4 text-center">
                  No files found
                  <br />
                  Use the buttons above to create files
                </div>
              ) : (
                <FileTree
                  data={fileTree}
                  onFileSelect={handleFileSelect}
                  selectedFile={selectedFile}
                  onCreateFile={handleCreateFile}
                  onCreateFolder={handleCreateFolder}
                />
              )}
            </div>

            {/* Code Editor - Right Panel */}
            <div className="flex-1 relative">
              {!selectedFile ? (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                  Select a file to edit
                </div>
              ) : editorError ? (
                <div className="flex items-center justify-center h-full text-red-600 text-sm p-4 text-center">
                  {editorError}
                </div>
              ) : loadingFileContent ? (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                  Loading file...
                </div>
              ) : (
                <CodeEditor
                  key={selectedFile}
                  value={fileContent}
                  onChange={handleContentChange}
                  language={currentLanguage}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
