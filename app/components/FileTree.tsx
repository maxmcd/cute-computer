import { useRef, useEffect, useState } from "react";
import { Tree } from "react-arborist";
import type { TreeNode } from "../lib/file-tree";

interface FileTreeProps {
  data: TreeNode[];
  onFileSelect: (filePath: string) => void;
  selectedFile: string | null;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onMoveFile?: (fromPath: string, toFolder: string) => void;
  openState?: { [id: string]: boolean };
  onOpenStateChange?: (openState: { [id: string]: boolean }) => void;
}

export function FileTree({
  data,
  onFileSelect,
  selectedFile,
  onCreateFile,
  onCreateFolder,
  onMoveFile,
  openState,
  onOpenStateChange,
}: FileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<any>(null);
  const [treeHeight, setTreeHeight] = useState(500);

  useEffect(() => {
    if (!containerRef.current) return;

    const updateHeight = () => {
      if (containerRef.current) {
        setTreeHeight(containerRef.current.clientHeight);
      }
    };

    // Set initial height
    updateHeight();

    // Update on resize
    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div className="h-full flex flex-col bg-white text-gray-800 font-mono text-sm">
      {/* Toolbar with create links */}
      <div className="flex gap-4 px-4 py-1 bg-gray-50 border-b border-gray-300 text-xs">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onCreateFile();
          }}
          className="text-purple-600 hover:text-purple-800 underline cursor-pointer"
          title="Create new file"
        >
          new file
        </a>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onCreateFolder();
          }}
          className="text-purple-600 hover:text-purple-800 underline cursor-pointer"
          title="Create new folder"
        >
          new folder
        </a>
      </div>

      {/* File tree or empty state */}
      <div ref={containerRef} className="flex-1 overflow-hidden pl-2 pt-1">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm p-4 text-center">
            No files yet
            <br />
            Click "New File" above to get started
          </div>
        ) : (
          <Tree
            ref={treeRef}
            data={data}
            openByDefault={false}
            initialOpenState={openState}
            width="100%"
            height={300}
            indent={16}
            rowHeight={28}
            overscanCount={10}
            className="file-tree"
            disableDrag={!onMoveFile}
            disableDrop={!onMoveFile}
            onSelect={(nodes) => {
              if (nodes.length > 0 && !nodes[0].data.isFolder) {
                onFileSelect(nodes[0].data.id);
              }
            }}
            onToggle={(id) => {
              // After toggle, save the new open state
              if (onOpenStateChange && treeRef.current) {
                // Use setTimeout to ensure state is updated
                setTimeout(() => {
                  if (treeRef.current) {
                    onOpenStateChange(treeRef.current.openState);
                  }
                }, 0);
              }
            }}
            onMove={(args) => {
              if (!onMoveFile) return;

              console.log("onMove called", {
                dragNodes: args.dragNodes.map((n) => ({
                  id: n.data.id,
                  name: n.data.name,
                })),
                parentNode: args.parentNode
                  ? {
                      id: args.parentNode.data.id,
                      name: args.parentNode.data.name,
                    }
                  : null,
                index: args.index,
              });

              const draggedNode = args.dragNodes[0];
              const parentNode = args.parentNode;

              // Get the target folder path
              let targetFolder = "";
              if (parentNode && parentNode.data.isFolder) {
                // Moving into a folder
                targetFolder = parentNode.data.id;
              }
              // If parentNode is null/undefined, moving to root (empty string)

              // Save current open state before move
              if (onOpenStateChange && treeRef.current) {
                onOpenStateChange(treeRef.current.openState);
              }

              // Call the move handler with source and destination
              onMoveFile(draggedNode.data.id, targetFolder);
            }}
          >
            {({ node, style, dragHandle }) => (
              <div
                style={style}
                ref={dragHandle}
                className={`flex items-center gap-1 px-2 cursor-pointer hover:bg-purple-100 ${
                  selectedFile === node.data.id ? "bg-purple-200" : ""
                }`}
                onClick={() => {
                  if (node.data.isFolder) {
                    node.toggle();
                  } else {
                    onFileSelect(node.data.id);
                  }
                }}
              >
                {/* Folder expansion indicator */}
                {node.data.isFolder ? (
                  <span className="select-none">{node.isOpen ? "▼" : "▶"}</span>
                ) : (
                  <span className="w-3" />
                )}
                {/* Name with trailing slash for folders */}
                <span className="truncate">
                  {node.data.name}
                  {node.data.isFolder ? "/" : ""}
                </span>
              </div>
            )}
          </Tree>
        )}
      </div>
    </div>
  );
}
