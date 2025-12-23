// Container API utilities - communicates with container file API

export interface FileInfo {
  path: string; // Relative to /home/cutie (e.g., "src/main.go")
  name: string; // Basename (e.g., "main.go")
  isDir: boolean; // True if directory
  size: number; // File size in bytes
}

/**
 * List all files in the container's filesystem
 * Returns a flat list of all files recursively
 */
export async function listContainerFiles(
  computerName: string
): Promise<FileInfo[]> {
  const response = await fetch(`/api/computer/${computerName}/files`);

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Get the content of a file from the container
 */
export async function getContainerFile(
  computerName: string,
  filepath: string
): Promise<string> {
  const response = await fetch(`/api/computer/${computerName}/files/${filepath}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`File not found: ${filepath}`);
    }
    throw new Error(`Failed to get file: ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Create or update a file in the container
 */
export async function putContainerFile(
  computerName: string,
  filepath: string,
  content: string
): Promise<void> {
  const response = await fetch(`/api/computer/${computerName}/files/${filepath}`, {
    method: "PUT",
    body: content,
    headers: {
      "Content-Type": "text/plain",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to put file: ${response.statusText}`);
  }
}

/**
 * Delete a file from the container
 */
export async function deleteContainerFile(
  computerName: string,
  filepath: string
): Promise<void> {
  const response = await fetch(`/api/computer/${computerName}/files/${filepath}`, {
    method: "DELETE",
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete file: ${response.statusText}`);
  }
}

/**
 * Move or rename a file in the container
 */
export async function moveContainerFile(
  computerName: string,
  from: string,
  to: string
): Promise<void> {
  const response = await fetch(`/api/computer/${computerName}/files/move`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to move file: ${response.statusText}`);
  }
}
