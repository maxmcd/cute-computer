import { useRef, useEffect, useState } from "react";
import { Tree } from "react-arborist";
import type { TreeNode } from "../lib/file-tree";

interface FileTreeProps {
  data: TreeNode[];
  onFileSelect: (filePath: string) => void;
  selectedFile: string | null;
  onCreateFile: () => void;
  onCreateFolder: () => void;
}

export function FileTree({ data, onFileSelect, selectedFile, onCreateFile, onCreateFolder }: FileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
      <div className="flex gap-4 px-3 py-2 border-b border-gray-300 text-xs">
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); onCreateFile(); }}
          className="text-purple-600 hover:text-purple-800 underline cursor-pointer"
          title="Create new file"
        >
          New File
        </a>
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); onCreateFolder(); }}
          className="text-purple-600 hover:text-purple-800 underline cursor-pointer"
          title="Create new folder"
        >
          New Folder
        </a>
      </div>

      {/* File tree */}
      <div ref={containerRef} className="flex-1 overflow-hidden pl-2">
        <Tree
        data={data}
        openByDefault={false}
        width="100%"
        height={treeHeight}
        indent={16}
        rowHeight={28}
        overscanCount={10}
        className="file-tree"
        onSelect={(nodes) => {
          if (nodes.length > 0 && !nodes[0].data.isFolder) {
            onFileSelect(nodes[0].data.id);
          }
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
              <span className="select-none">
                {node.isOpen ? "▼" : "▶"}
              </span>
            ) : (
              <span className="w-3" />
            )}
            {/* Name with trailing slash for folders */}
            <span className="truncate">
              {node.data.name}{node.data.isFolder ? "/" : ""}
            </span>
          </div>
        )}
      </Tree>
      </div>
    </div>
  );
}
