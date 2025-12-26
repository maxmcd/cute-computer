import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { FileTree } from "../components/FileTree";
import { CodeEditor } from "../components/CodeEditor";
import { Window } from "../components/Window";
import { ViewContainer } from "../components/ViewContainer";
import {
  listContainerFiles,
  getContainerFile,
  putContainerFile,
  deleteContainerFile,
  moveContainerFile,
} from "../lib/container";
import {
  buildFileTree,
  sortTreeNodes,
  detectLanguage,
  moveFileInTree,
} from "../lib/file-tree";
import type { TreeNode } from "../lib/file-tree";

export async function loader({ params, context, request }: LoaderFunctionArgs) {
  const { name } = params;

  if (!name) {
    throw new Response("Computer not found", { status: 404 });
  }

  const env = context.cloudflare.env;

  // Verify computer exists
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));
  const computer = await computersStub.getComputer(name);

  if (!computer) {
    throw new Response("Computer not found", { status: 404 });
  }

  // Extract host from request
  const url = new URL(request.url);
  const result = {
    computerName: computer.name,
    computerSlug: computer.slug,
    createdAt: computer.created_at,
    host: url.host,
    scheme: url.origin.slice(0, url.origin.length - url.host.length),
  };
  return result;
}

export function meta({ data }: any) {
  return [
    { title: `${data?.computerName || "Computer"} - Cute Computer` },
    { name: "description", content: "" },
  ];
}

type ViewType = "terminal" | "editor" | "logs" | "preview";

export default function Computer() {
  const navigate = useNavigate();
  const params = useParams();
  const loaderData = useLoaderData<typeof loader>();
  const computerName = params.name!; // This is the slug
  const splat = params["*"] || "";
  const view = (splat || "landing") as ViewType | "landing";

  // Terminal state
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [statusText, setStatusText] = useState("Connecting...");
  const [reconnectMessage, setReconnectMessage] = useState("");

  // Computer display name from loader
  const {
    computerName: computerDisplayName,
    createdAt,
    host,
    scheme,
  } = loaderData;

  // Editor state
  const [fileTree, setFileTree] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingFileContent, setLoadingFileContent] = useState(false);
  const [editorError, setEditorError] = useState<string>("");
  const [treeOpenState, setTreeOpenState] = useState<{ [id: string]: boolean }>(
    {}
  );
  const fileCacheRef = useRef<Map<string, string>>(new Map());
  const fileSizesRef = useRef<Map<string, number>>(new Map());

  const subdomainUrl = `${scheme}${computerName}.${host}`;
  // Initialize terminal (only when terminal view is active)
  useEffect(() => {
    if (view !== "terminal") return;
    if (!containerRef.current) return;

    let mounted = true;

    async function initTerminal() {
      if (!containerRef.current) return;

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
          cursor: "#e879f9",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      await term.open(containerRef.current);
      fitAddon.fit();
      fitAddon.observeResize();

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

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

      term.onData((data: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      let resizeTimeout: ReturnType<typeof setTimeout>;
      function debouncedFit() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => fitAddon.fit(), 50);
      }

      window.addEventListener("resize", debouncedFit);
      const resizeObserver = new ResizeObserver(debouncedFit);
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      return () => {
        mounted = false;
        window.removeEventListener("resize", debouncedFit);
        resizeObserver.disconnect();
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
  }, [view, computerName]);

  // Initialize editor (only when needed)
  useEffect(() => {
    if (view !== "editor") return;

    async function initEditor() {
      try {
        setLoadingFiles(true);
        setEditorError("");

        const files = await listContainerFiles(computerName);

        // Store file sizes for later checking
        fileSizesRef.current.clear();
        files.forEach((file) => {
          if (!file.isDir) {
            fileSizesRef.current.set(file.path, file.size);
          }
        });

        // Convert to keys, adding trailing slash for directories
        const keys = files.map((file) =>
          file.isDir ? `${file.path}/` : file.path
        );
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
  }, [view, computerName]);

  const handleContentChange = (newContent: string) => {
    setFileContent(newContent);
    setIsDirty(newContent !== originalContent);
  };

  // Auto-save
  useEffect(() => {
    if (!selectedFile || !isDirty) return;

    const autoSaveTimer = setTimeout(async () => {
      try {
        setIsSaving(true);
        await putContainerFile(computerName, selectedFile, fileContent);
        setOriginalContent(fileContent);
        setIsDirty(false);
        fileCacheRef.current.set(selectedFile, fileContent);
      } catch (error) {
        console.error("Auto-save failed:", error);
      } finally {
        setIsSaving(false);
      }
    }, 500);

    return () => clearTimeout(autoSaveTimer);
  }, [fileContent, selectedFile, isDirty, computerName]);

  const handleFileSelect = async (filePath: string) => {
    if (isDirty && selectedFile) {
      try {
        await putContainerFile(computerName, selectedFile, fileContent);
        setOriginalContent(fileContent);
        setIsDirty(false);
        fileCacheRef.current.set(selectedFile, fileContent);
      } catch (error) {
        console.error("Failed to auto-save before switching files:", error);
      }
    }

    try {
      setEditorError("");

      // Check file size before loading
      const maxFileSize = 1024 * 1024; // 1MB
      const fileSize = fileSizesRef.current.get(filePath);
      if (fileSize !== undefined && fileSize > maxFileSize) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        setEditorError(
          `Cannot open file: ${filePath.split("/").pop()} is ${sizeMB}MB (max 1MB)`
        );
        setSelectedFile(null);
        setFileContent("");
        setOriginalContent("");
        setIsDirty(false);
        return;
      }

      const cached = fileCacheRef.current.get(filePath);
      if (cached !== undefined) {
        setFileContent(cached);
        setOriginalContent(cached);
        setIsDirty(false);
        setLoadingFileContent(false);
      } else {
        setLoadingFileContent(true);
        const content = await getContainerFile(computerName, filePath);

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
      return;
    }

    setSelectedFile(filePath);
  };

  const refreshFileTree = async () => {
    try {
      setLoadingFiles(true);
      const files = await listContainerFiles(computerName);

      // Store file sizes for later checking
      fileSizesRef.current.clear();
      files.forEach((file) => {
        if (!file.isDir) {
          fileSizesRef.current.set(file.path, file.size);
        }
      });

      // Convert to keys, adding trailing slash for directories
      const keys = files.map((file) =>
        file.isDir ? `${file.path}/` : file.path
      );
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

  const handleCreateFile = async () => {
    const fileName = window.prompt("Enter file name (e.g., script.js):");
    if (!fileName) return;

    const cleanFileName = fileName.replace(/^\/+/, "");

    try {
      setEditorError("");
      await putContainerFile(computerName, cleanFileName, "");
      await refreshFileTree();
      // Clear content and select new file
      setFileContent("");
      setOriginalContent("");
      setIsDirty(false);
      setSelectedFile(cleanFileName);
    } catch (error) {
      console.error("Failed to create file:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to create file"
      );
    }
  };

  const handleCreateFolder = async () => {
    const folderName = window.prompt("Enter folder name (e.g., src):");
    if (!folderName) return;

    const cleanFolderName = folderName.replace(/^\/+|\/+$/g, "");
    const folderPath = `${cleanFolderName}/`;

    try {
      setEditorError("");
      await putContainerFile(computerName, folderPath, "");
      await refreshFileTree();
    } catch (error) {
      console.error("Failed to create folder:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to create folder"
      );
    }
  };

  const handleDeleteFile = async () => {
    if (!selectedFile) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete "${selectedFile}"?`
    );
    if (!confirmed) return;

    try {
      setEditorError("");
      await deleteContainerFile(computerName, selectedFile);

      // Clear selection and refresh tree
      fileCacheRef.current.delete(selectedFile);
      setSelectedFile(null);
      setFileContent("");
      setOriginalContent("");
      setIsDirty(false);
      await refreshFileTree();
    } catch (error) {
      console.error("Failed to delete file:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to delete file"
      );
    }
  };

  const handleRenameFile = async () => {
    if (!selectedFile) return;

    const newName = window.prompt("Enter new file name:", selectedFile);
    if (!newName || newName === selectedFile) return;

    const cleanNewName = newName.replace(/^\/+/, "");

    try {
      setEditorError("");

      // Move file to new name
      await moveContainerFile(computerName, selectedFile, cleanNewName);

      // Update cache
      fileCacheRef.current.delete(selectedFile);
      fileCacheRef.current.set(cleanNewName, fileContent);

      // Update selection and refresh
      setSelectedFile(cleanNewName);
      setOriginalContent(fileContent);
      setIsDirty(false);
      await refreshFileTree();
    } catch (error) {
      console.error("Failed to rename file:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to rename file"
      );
    }
  };

  const handleMoveFile = async (fromPath: string, toFolder: string) => {
    try {
      setEditorError("");

      // Calculate new path
      const fileName = fromPath.split("/").pop();
      if (!fileName) {
        throw new Error("Invalid file path");
      }
      const newPath = toFolder ? `${toFolder}/${fileName}` : fileName;

      // Don't move if it's the same location
      if (newPath === fromPath) {
        return;
      }

      // Update tree immediately without server round-trip
      const updatedTree = moveFileInTree(fileTree, fromPath, toFolder);
      setFileTree(updatedTree);

      // Update selection if moving currently selected file
      if (selectedFile === fromPath) {
        setSelectedFile(newPath);
      }

      // Now perform server operation
      await moveContainerFile(computerName, fromPath, newPath);

      // Update cache
      const content = fileCacheRef.current.get(fromPath);
      if (content !== undefined) {
        fileCacheRef.current.delete(fromPath);
        fileCacheRef.current.set(newPath, content);
      }

      // Update file content if this was the selected file
      if (selectedFile === fromPath && content !== undefined) {
        setFileContent(content);
        setOriginalContent(content);
      }
    } catch (error) {
      console.error("Failed to move file:", error);
      setEditorError(
        error instanceof Error ? error.message : "Failed to move file"
      );

      // On error, refresh tree from server to get correct state
      await refreshFileTree();
    }
  };

  const currentLanguage = selectedFile ? detectLanguage(selectedFile) : "text";
  const fileName = selectedFile
    ? selectedFile.split("/").pop() || "No file selected"
    : "No file selected";

  const handleCloseView = () => {
    navigate(`/computer/${computerName}`);
  };

  // Landing page view
  if (view === "landing") {
    return (
      <div className="min-h-screen w-full flex flex-col bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-300">
        <style>{`
          body {
            background: linear-gradient(135deg, #fbcfe8 0%, #e9d5ff 50%, #c7d2fe 100%);
            margin: 0;
          }
        `}</style>

        {/* Cute Computer Title Bar */}
        <div className="w-full px-10 py-6">
          <a
            href="/"
            className="flex items-center gap-3 hover:opacity-80 transition-opacity font-mono"
          >
            <span className="text-2xl text-purple-900">{">_<"}</span>
            <h1 className="text-2xl font-bold text-purple-900">
              Cute Computer
            </h1>
          </a>
        </div>

        {/* Content Container */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 md:px-10 gap-8 pb-10">
          {/* Computer Info Panel */}
          <div className="w-full md:max-w-2xl bg-white rounded-2xl shadow-2xl p-8 font-mono">
            <div>
              <div className="space-y-2 text-sm pb-1 text-gray-500">
                computer
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">
                {computerDisplayName}
              </h2>

              <div className="space-y-2 text-sm">
                <div className="text-gray-900">
                  created:{" "}
                  <span className="text-gray-900">
                    {new Date(createdAt).toLocaleDateString()} at{" "}
                    {new Date(createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <div className="">
                  <span className="text-gray-900 whitespace-nowrap">
                    address:{" "}
                  </span>
                  <a
                    href={subdomainUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-600 hover:text-purple-800 underline break-all"
                  >
                    {subdomainUrl}
                  </a>
                </div>
              </div>
            </div>
          </div>

          {/* View Icons */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full md:max-w-2xl">
            <button
              onClick={() => navigate(`/computer/${computerName}/terminal`)}
              className="flex flex-col items-center gap-2 p-6 rounded-xl hover:bg-purple-50 transition-colors group cursor-pointer"
            >
              <img
                src="/terminal.png"
                alt="Terminal"
                className="w-20 h-20 md:w-16 md:h-16 object-contain opacity-70 group-hover:opacity-100 transition-all duration-200"
                style={{
                  filter:
                    "sepia(100%) saturate(300%) hue-rotate(280deg) brightness(0.9)",
                }}
              />
              <span className="text-sm font-medium text-gray-700 group-hover:text-purple-900">
                Terminal
              </span>
            </button>

            <button
              onClick={() => navigate(`/computer/${computerName}/editor`)}
              className="flex flex-col items-center gap-2 p-6 rounded-xl hover:bg-purple-50 transition-colors group cursor-pointer"
            >
              <img
                src="/editor.png"
                alt="Editor"
                className="w-20 h-20 md:w-16 md:h-16 object-contain opacity-70 group-hover:opacity-100 transition-all duration-200"
                style={{
                  filter:
                    "sepia(100%) saturate(300%) hue-rotate(280deg) brightness(0.9)",
                }}
              />
              <span className="text-sm font-medium text-gray-700 group-hover:text-purple-900">
                Editor
              </span>
            </button>

            <button
              onClick={() => navigate(`/computer/${computerName}/logs`)}
              className="flex flex-col items-center gap-2 p-6 rounded-xl hover:bg-purple-50 transition-colors group cursor-pointer"
            >
              <img
                src="/logs.png"
                alt="Logs"
                className="w-20 h-20 md:w-16 md:h-16 object-contain opacity-70 group-hover:opacity-100 transition-all duration-200"
                style={{
                  filter:
                    "sepia(100%) saturate(300%) hue-rotate(280deg) brightness(0.9)",
                }}
              />
              <span className="text-sm font-medium text-gray-700 group-hover:text-purple-900">
                Logs
              </span>
            </button>

            <button
              onClick={() => navigate(`/computer/${computerName}/preview`)}
              className="flex flex-col items-center gap-2 p-6 rounded-xl hover:bg-purple-50 transition-colors group cursor-pointer"
            >
              <img
                src="/preview.png"
                alt="Preview"
                className="w-20 h-20 md:w-16 md:h-16 object-contain opacity-70 group-hover:opacity-100 transition-all duration-200"
                style={{
                  filter:
                    "sepia(100%) saturate(300%) hue-rotate(280deg) brightness(0.9)",
                }}
              />
              <span className="text-sm font-medium text-gray-700 group-hover:text-purple-900">
                Preview
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Terminal view
  if (view === "terminal") {
    return (
      <ViewContainer computerName={computerName}>
        <Window
          title={
            <>
              {computerDisplayName}
              {reconnectMessage && (
                <span className="text-pink-600 text-xs ml-4">
                  {reconnectMessage}
                </span>
              )}
            </>
          }
          onClose={handleCloseView}
          rightContent={
            <div className="flex items-center gap-1.5 text-[11px] text-purple-700">
              <div
                className={`w-2 h-2 rounded-full ${
                  status === "connected"
                    ? "bg-green-400"
                    : status === "disconnected"
                      ? "bg-pink-400"
                      : "bg-purple-400"
                }`}
              ></div>
              <span>{statusText}</span>
            </div>
          }
        >
          <div
            ref={containerRef}
            className="terminal-container flex-1 min-h-0 bg-white relative overflow-hidden"
            style={{ caretColor: "transparent" }}
          ></div>
        </Window>
      </ViewContainer>
    );
  }

  // Editor view
  if (view === "editor") {
    return (
      <ViewContainer computerName={computerName}>
        <Window
          title={fileName}
          onClose={handleCloseView}
          rightContent={
            <div className="text-xs text-purple-700 font-medium">
              {isSaving ? "Saving..." : isDirty ? "Unsaved" : "Saved"}
            </div>
          }
        >
          <div className="flex flex-1 min-h-0">
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
              ) : (
                <FileTree
                  data={fileTree}
                  onFileSelect={handleFileSelect}
                  selectedFile={selectedFile}
                  onCreateFile={handleCreateFile}
                  onCreateFolder={handleCreateFolder}
                  onMoveFile={handleMoveFile}
                  openState={treeOpenState}
                  onOpenStateChange={setTreeOpenState}
                />
              )}
            </div>

            {/* Code Editor - Right Panel */}
            <div className="flex-1 relative flex flex-col">
              {/* File Actions Header */}
              {selectedFile && (
                <div className="flex items-center justify-between px-4 py-1 bg-gray-50 border-b border-gray-300">
                  <div className="text-xs text-gray-600 font-mono">
                    {selectedFile}
                  </div>
                  <div className="flex gap-3 text-xs font-mono">
                    <button
                      onClick={handleRenameFile}
                      className="text-purple-600 hover:text-purple-800 underline"
                    >
                      rename
                    </button>
                    <button
                      onClick={handleDeleteFile}
                      className="text-purple-600 hover:text-purple-800 underline"
                    >
                      delete
                    </button>
                  </div>
                </div>
              )}

              {!selectedFile ? (
                <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                  Select a file to edit
                </div>
              ) : editorError ? (
                <div className="flex items-center justify-center h-full text-red-600 text-sm p-4 text-center">
                  {editorError}
                </div>
              ) : loadingFileContent ? (
                <div className="flex items-center justify-center flex-1 text-gray-600 text-sm">
                  Loading file...
                </div>
              ) : (
                <div className="flex-1">
                  <CodeEditor
                    key={selectedFile}
                    value={fileContent}
                    onChange={handleContentChange}
                    language={currentLanguage}
                  />
                </div>
              )}
            </div>
          </div>
        </Window>
      </ViewContainer>
    );
  }

  // Logs view
  if (view === "logs") {
    return (
      <ViewContainer computerName={computerName}>
        <LogsView computerName={computerName} onClose={handleCloseView} />
      </ViewContainer>
    );
  }

  // Preview view
  if (view === "preview") {
    return (
      <ViewContainer computerName={computerName}>
        <Window title={`Preview - ${subdomainUrl}`} onClose={handleCloseView}>
          {subdomainUrl && (
            <iframe
              src={subdomainUrl}
              className="w-full flex-1 min-h-0 border-0"
              title="Preview"
            />
          )}
        </Window>
      </ViewContainer>
    );
  }

  return null;
}

// Logs View Component
function LogsView({
  computerName,
  onClose,
}: {
  computerName: string;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    async function fetchLogs() {
      try {
        setLoading(true);
        setError("");
        const params = new URLSearchParams({ limit: "100" });
        if (debouncedSearch) {
          params.set("search", debouncedSearch);
        }
        const response = await fetch(
          `/api/computer/${computerName}/logs?${params}`
        );
        if (!response.ok) {
          throw new Error(`Failed to fetch logs: ${response.statusText}`);
        }
        const data = (await response.json()) as any[];
        setLogs(data);
      } catch (err) {
        console.error("Failed to load logs:", err);
        setError(err instanceof Error ? err.message : "Failed to load logs");
      } finally {
        setLoading(false);
      }
    }

    fetchLogs();

    // Auto-refresh every 5 seconds with current search
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [computerName, debouncedSearch]);

  const formatTimestamp = (tsSec: number, tsNsec: number) => {
    const date = new Date(tsSec * 1000);
    const ms = Math.floor(tsNsec / 1_000_000);
    // Use 24-hour format with leading zeros
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    return `${hours}:${minutes}:${seconds}.${ms.toString().padStart(3, "0")}`;
  };

  // Render log with highlighting
  const renderLogWithHighlight = (highlightedLog: string) => {
    // Split by <mark> tags and render with highlighting
    const parts = highlightedLog.split(/(<mark>.*?<\/mark>)/g);
    return (
      <>
        {parts.map((part, i) => {
          if (part.startsWith("<mark>") && part.endsWith("</mark>")) {
            const text = part.slice(6, -7); // Remove <mark> and </mark>
            return (
              <mark key={i} className="bg-yellow-200 px-0.5">
                {text}
              </mark>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </>
    );
  };

  return (
    <Window title="Logs" onClose={onClose}>
      <div className="flex-1 min-h-0 flex flex-col bg-white">
        {/* Search Bar */}
        <div className="border-b border-gray-300 p-3 flex-shrink-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search logs..."
              className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="px-3 py-1.5 text-sm text-purple-600 hover:text-purple-800 font-medium"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Logs Content */}
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Loading logs...
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-red-600 text-sm p-4 text-center">
            {error}
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            {debouncedSearch ? "No logs found" : "No logs yet"}
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4 font-mono text-xs">
            {logs.map((log, idx) => (
              <div key={idx} className="mb-1 flex gap-3">
                <span className="text-gray-400 flex-shrink-0">
                  {formatTimestamp(log.ts_sec, log.ts_nsec)}
                </span>
                <span className="text-gray-800">
                  {renderLogWithHighlight(log.highlighted_log)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Window>
  );
}
