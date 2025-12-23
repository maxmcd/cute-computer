// Utilities for converting flat S3 key lists into hierarchical tree structures

export interface TreeNode {
  id: string;
  name: string;
  isFolder: boolean;
  children?: TreeNode[];
}

/**
 * Convert a flat list of S3 keys into a hierarchical tree structure
 * Example: ["home/cutie/foo.js", "home/cutie/dir/bar.js"]
 * Becomes a nested tree with home -> cutie -> [foo.js, dir -> bar.js]
 */
export function buildFileTree(keys: string[]): TreeNode[] {
  const root: TreeNode = {
    id: "",
    name: "",
    isFolder: true,
    children: [],
  };

  // Build the tree by processing each key
  keys.forEach((key) => {
    // Handle directory markers (keys ending with /)
    const isDirectoryMarker = key.endsWith("/");
    const cleanKey = isDirectoryMarker ? key.slice(0, -1) : key;

    // Split into parts, filtering out empty strings
    const parts = cleanKey.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) return; // Skip empty keys

    let currentNode = root;

    parts.forEach((part, index) => {
      const isLastPart = index === parts.length - 1;
      const pathSoFar = parts.slice(0, index + 1).join("/");

      // Check if this node already exists in children
      let existingNode = currentNode.children?.find(
        (child) => child.name === part
      );

      if (!existingNode) {
        // Create new node
        // It's a folder if it's not the last part, OR if it's the last part of a directory marker
        const isFolder = !isLastPart || (isLastPart && isDirectoryMarker);
        const newNode: TreeNode = {
          id: pathSoFar,
          name: part,
          isFolder: isFolder,
          children: isFolder ? [] : undefined,
        };

        if (!currentNode.children) {
          currentNode.children = [];
        }
        currentNode.children.push(newNode);
        existingNode = newNode;
      } else if (isLastPart && isDirectoryMarker && !existingNode.isFolder) {
        // If we encounter a directory marker for a node that was previously marked as a file,
        // upgrade it to a folder
        existingNode.isFolder = true;
        if (!existingNode.children) {
          existingNode.children = [];
        }
      }

      // Move down the tree
      if (!isLastPart || (isLastPart && isDirectoryMarker)) {
        currentNode = existingNode;
      }
    });
  });

  return root.children || [];
}

/**
 * Sort tree nodes: folders first, then files, alphabetically within each group
 */
export function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .sort((a, b) => {
      // Folders before files
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;

      // Alphabetically
      return a.name.localeCompare(b.name);
    })
    .map((node) => ({
      ...node,
      children: node.children ? sortTreeNodes(node.children) : undefined,
    }));
}

/**
 * Get file extension from a filename
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1 || lastDot === 0) return "";
  return filename.slice(lastDot + 1).toLowerCase();
}

/**
 * Detect programming language from file extension
 */
export function detectLanguage(filename: string): string {
  const ext = getFileExtension(filename);

  const languageMap: Record<string, string> = {
    js: "javascript",
    jsx: "javascript", // Monaco handles JSX within javascript/typescript
    ts: "typescript",
    tsx: "typescript", // Monaco handles TSX within typescript
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    json: "json",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    markdown: "markdown",
    sh: "shell", // Monaco uses "shell" instead of "bash"
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    txt: "plaintext", // Monaco uses "plaintext" instead of "text"
  };

  return languageMap[ext] || "plaintext";
}

/**
 * Move a file in the tree structure (optimistic update)
 * Returns a new tree with the file moved
 */
export function moveFileInTree(
  nodes: TreeNode[],
  fromPath: string,
  toFolderPath: string
): TreeNode[] {
  // Calculate the new path
  const fileName = fromPath.split("/").pop();
  if (!fileName) {
    return nodes;
  }

  const newPath = toFolderPath ? `${toFolderPath}/${fileName}` : fileName;

  // If same location, no change
  if (newPath === fromPath) {
    return nodes;
  }

  // Find and remove the node from its current location
  let movedNode: TreeNode | null = null;

  function removeNode(nodes: TreeNode[], path: string): TreeNode[] {
    const result: TreeNode[] = [];

    for (const node of nodes) {
      if (node.id === path) {
        // Found the node to remove - save it and don't include in result
        movedNode = { ...node };
        continue;
      }

      // If this node has children, recursively check them
      if (node.children) {
        const updatedChildren = removeNode(node.children, path);
        result.push({
          ...node,
          children: updatedChildren,
        });
      } else {
        result.push(node);
      }
    }

    return result;
  }

  // Insert the node at the new location
  function insertNode(
    nodes: TreeNode[],
    folderPath: string,
    nodeToInsert: TreeNode
  ): TreeNode[] {
    // Update the node with new id and name (fileName is guaranteed to exist by early return above)
    const updatedNode: TreeNode = {
      ...nodeToInsert,
      id: newPath,
      name: fileName!, // Safe because we checked above
    };

    // If inserting at root
    if (!folderPath) {
      return sortTreeNodes([...nodes, updatedNode]);
    }

    return nodes.map((node) => {
      if (node.id === folderPath && node.isFolder) {
        return {
          ...node,
          children: sortTreeNodes([...(node.children || []), updatedNode]),
        };
      }
      if (node.children) {
        return {
          ...node,
          children: insertNode(node.children, folderPath, nodeToInsert),
        };
      }
      return node;
    });
  }

  // Perform the move
  let newTree = removeNode(nodes, fromPath);

  if (movedNode) {
    newTree = insertNode(newTree, toFolderPath, movedNode);
  }

  return newTree;
}
