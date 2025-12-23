# AI Agents Guide for Cute Computer

This document provides context for AI coding agents working on the Cute Computer project. It contains architectural decisions, implementation patterns, and important gotchas to help agents work effectively.

---

## Project Overview

**Cute Computer** is a web-based development environment that runs entirely on Cloudflare's infrastructure:
- **Frontend**: React + Remix, deployed as Cloudflare Pages
- **Backend**: Cloudflare Workers + Durable Objects
- **Container Runtime**: Cloudflare Workers with WebContainers
- **Storage**: S3-compatible API via Durable Objects
- **Editor**: Monaco Editor (VS Code's editor component)

### Key Philosophy
- Serverless-first architecture
- Real-time file synchronization
- Browser-based development experience
- No traditional servers or databases

---

## Architecture

### Component Stack

```
┌─────────────────────────────────────┐
│   Browser (React + Remix)          │
│   - Monaco Editor                   │
│   - File Tree                       │
│   - Terminal (xterm.js)             │
└─────────────┬───────────────────────┘
              │ HTTP + WebSocket
┌─────────────▼───────────────────────┐
│   Cloudflare Worker                 │
│   - Request routing                 │
│   - Proxy to container              │
└─────────────┬───────────────────────┘
              │
┌─────────────▼───────────────────────┐
│   Container (Durable Object)        │
│   - File API (Go HTTP server)       │
│   - Terminal (WebSocket PTY)        │
│   - FUSE mount to S3 DO             │
└─────────────┬───────────────────────┘
              │
┌─────────────▼───────────────────────┐
│   S3 DO: Persistent storage         │
└─────────────────────────────────────┘
```

### Directory Structure

```
cute-computer/
├── app/                    # Frontend (Remix)
│   ├── components/        # React components
│   ├── lib/              # Utilities (S3, file-tree)
│   └── routes/           # Remix routes
├── worker/                # Backend (Cloudflare Worker)
│   ├── lib/              # JWT utilities
│   ├── computers.ts      # Computer DO
│   ├── s3.ts            # S3 DO
│   └── index.ts         # Worker entry
├── container_src/         # Go container runtime
└── public/               # Static assets
```

---

## Critical Implementation Patterns

### 1. Container File API

**Context**: File operations go through the container's HTTP API rather than directly to S3.

**Implementation**:
```typescript
// Frontend uses container API
import { listContainerFiles, getContainerFile, putContainerFile } from "../lib/container"

// List all files
const files = await listContainerFiles(computerName)

// Read file
const content = await getContainerFile(computerName, "src/main.go")

// Write file
await putContainerFile(computerName, "src/main.go", content)

// Move file
await moveContainerFile(computerName, "old.go", "new.go")
```

**API Routes**:
- `GET /api/files` - List all files recursively
- `GET /api/files/:path` - Read file content
- `PUT /api/files/:path` - Create/update file
- `DELETE /api/files/:path` - Delete file
- `POST /api/files/move` - Move/rename file

**Worker Proxy**:
```typescript
// Frontend requests go through worker proxy
GET /api/computer/:name/files → Container GET /api/files
GET /api/computer/:name/files/src/main.go → Container GET /api/files/src/main.go
```

**Benefits**:
- Single source of truth (container filesystem)
- Simpler mental model (files where they run)
- Opens door for LSP, file watching, build tools
- No JWT complexity for file operations

**Files**:
- `app/lib/container.ts` - Frontend API client
- `container_src/main.go` - Container HTTP handlers
- `app/routes/api/computer.$name.files.$.ts` - Worker proxy

### 2. Path Format and Security

**Critical**: All file paths are relative to `/home/cutie` and must be validated.

**Path Format**:
```
Absolute (in container): /home/cutie/src/main.go
Relative (in API):       src/main.go

Absolute (in container): /home/cutie/config.json
Relative (in API):       config.json
```

**Security**:
```go
// main.go validates all paths
func validateAndResolvePath(relativePath string) (string, error) {
    cleanPath := filepath.Clean(relativePath)
    cleanPath = strings.TrimPrefix(cleanPath, "/")
    absPath := filepath.Join("/home/cutie", cleanPath)
    
    // Ensure path is within /home/cutie
    if !strings.HasPrefix(absPath, "/home/cutie/") && absPath != "/home/cutie" {
        return "", fmt.Errorf("invalid path")
    }
    
    return absPath, nil
}
```

**Files**:
- `container_src/main.go` - Path validation functions

### 3. JWT Authentication ("The AWS Key Hack")

**Context**: Cloudflare's S3-compatible API doesn't natively support custom auth, so we repurpose the AWS credential fields.

**Implementation**:
```typescript
// Frontend creates JWT
const jwt = await createJWT({ computerName, doId }, secret, "1h")

// JWT passed as AWS_ACCESS_KEY_ID
const credentials = {
  accessKeyId: jwt,        // ← JWT goes here!
  secretAccessKey: "x",    // ← Ignored
}

// S3 DO extracts JWT from Authorization header
const authHeader = request.headers.get("Authorization")
const jwt = extractJWT(authHeader)  // Parse from AWS4-HMAC-SHA256 format
await verifyJWT(jwt, secret)
```

**Why This Works**:
- AWS clients automatically add credentials to Authorization header
- We intercept the header and extract the JWT
- No modifications needed to S3 client libraries

**Token Lifetimes**:
- Frontend tokens: 1 hour (cached, auto-refresh on expiry)
- Container tokens: 24 hours (set once at startup)

**Files**:
- `app/lib/s3.ts` - Frontend JWT creation
- `worker/lib/jwt.ts` - JWT utilities
- `worker/s3.ts` - JWT verification in S3 DO

### 2. Optimistic UI Updates

**Pattern**: Update UI immediately, perform server operations in background, revert on error.

**Example** (file drag & drop):
```typescript
const handleMoveFile = async (fromPath, toFolderPath) => {
  // 1. Immediate UI update (optimistic)
  setFileTree(moveFileInTree(fileTree, fromPath, toFolderPath))
  
  try {
    // 2. Server operations (async, may fail)
    const content = await getS3Object(...)
    await putS3Object(...)
    await deleteS3Object(...)
    
    // 3. Update cache
    fileCacheRef.current.set(newPath, content)
    fileCacheRef.current.delete(oldPath)
  } catch (error) {
    // 4. Revert on error
    await refreshFileTree()
  }
}
```

**Benefits**:
- Zero perceived latency
- Feels like native app
- Graceful error handling

**Files**:
- `app/routes/computer.$name.tsx` - Optimistic updates
- `app/lib/file-tree.ts` - Pure transformation functions

### 3. Immutable State Transformations

**Critical**: React state updates must create new objects, not mutate existing ones.

**❌ Wrong** (mutates original):
```typescript
function removeNode(nodes, path) {
  for (let node of nodes) {
    if (node.id === path) {
      nodes.splice(nodes.indexOf(node), 1)  // ← Mutates!
    }
  }
  return nodes
}
```

**✅ Correct** (returns new object):
```typescript
function removeNode(nodes, path) {
  return nodes
    .filter(node => node.id !== path)
    .map(node => ({
      ...node,
      children: node.children ? removeNode(node.children, path) : undefined
    }))
}
```

**Files**:
- `app/lib/file-tree.ts` - All transformations are pure functions

---

## Component-Specific Patterns

### File Tree (react-arborist)

**Component**: `app/components/FileTree.tsx`

**State Management**:
```typescript
// Parent manages open state
const [treeOpenState, setTreeOpenState] = useState<{ [id: string]: boolean }>({})

<FileTree
  data={fileTree}
  openState={treeOpenState}
  onOpenStateChange={setTreeOpenState}
  onMoveFile={handleMoveFile}
/>
```

**Open State Persistence**:
```typescript
const treeRef = useRef<TreeApi<TreeNode>>(null)

// Save on toggle
const handleToggle = () => {
  if (treeRef.current?.openState) {
    onOpenStateChange?.(treeRef.current.openState)
  }
}

// Restore on render
<Tree
  ref={treeRef}
  initialOpenState={openState}
  onToggle={handleToggle}
/>
```

**Drag & Drop**:
- `onMove` receives `{ dragNodes, parentNode, index }`
- `parentNode === null` means dropping at root level
- Must save open state before move to prevent collapse

**Critical CSS**:
- Container needs `pb-20` for extended drop zone at bottom
- Without it, dropping at root level is nearly impossible

### Monaco Editor

**Component**: `app/components/CodeEditor.tsx`

**File Management**:
```typescript
// Editor uses models for each file
const model = monaco.editor.getModel(uri) || 
              monaco.editor.createModel(content, language, uri)

// Save triggered by Cmd+S
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
  onSave?.(editor.getValue())
})
```

**Language Detection**:
- Uses file extension: `.ts` → TypeScript, `.go` → Go, etc.
- Monaco auto-configures syntax highlighting

### S3 Client

**Files**: `app/lib/s3.ts`, `worker/s3.ts`

**Frontend Operations**:
```typescript
// Always use authenticated helpers
await getS3Object(computerName, doId, key)
await putS3Object(computerName, doId, key, content)
await deleteS3Object(computerName, doId, key)
await listS3Objects(computerName, doId, prefix)

// Never use raw fetch() - bypasses auth!
```

**S3 DO Validation**:
```typescript
// Every request validates JWT
const jwt = extractJWT(request.headers.get("Authorization"))
const payload = await verifyJWT(jwt, this.env.COMPUTER_JWT_SECRET)

// Check computer name matches
if (payload.computerName !== this.computerName) {
  return new Response("Unauthorized", { status: 401 })
}
```

**Path Conventions**:
- Files: `src/utils.ts` (no leading slash)
- Folders: `src/` (trailing slash in S3, NOT in tree node ids)
- Root files: `README.md` (no prefix)

---

## Common Gotchas

### 1. **Folder Paths in Tree vs S3**

**Problem**: Tree node ids don't include trailing slash, but S3 requires it.

```typescript
// Tree node
{ id: "src", isFolder: true }

// S3 operation
await putS3Object(name, doId, "src/", "")  // ← Note the trailing /
```

**Solution**: Add `/` when making S3 calls for folders.

### 2. **React State Updates Not Triggering Re-render**

**Cause**: Mutating state instead of creating new objects.

**Symptoms**:
- UI doesn't update after state change
- State looks correct in debugger but UI is stale

**Fix**: Always use immutable updates (spread operator, `.map()`, `.filter()`).

### 3. **JWT Expiry**

**Frontend**: Tokens cached for 1 hour, automatically refresh on expiry.

**Container**: 24-hour tokens set at startup, NO auto-refresh.
- If container runs >24h, S3 operations will fail
- Must restart container to get new token

### 4. **Monaco Editor Model Leaks**

**Problem**: Creating models without disposing them causes memory leaks.

**Fix**: Reuse existing models:
```typescript
let model = monaco.editor.getModel(uri)
if (!model) {
  model = monaco.editor.createModel(content, language, uri)
}
```

### 5. **File Cache Synchronization**

**Critical**: When moving/deleting files, update cache immediately.

```typescript
// Move
fileCacheRef.current.set(newPath, content)
fileCacheRef.current.delete(oldPath)

// Delete  
fileCacheRef.current.delete(path)

// Rename
fileCacheRef.current.set(newPath, content)
fileCacheRef.current.delete(oldPath)
```

---

## Testing

### Running Tests

```bash
# Worker tests (S3 operations)
bun run vitest run worker/test/s3.test.ts

# Type checking
bun run typecheck
```

### Test Structure

**Files**: `worker/test/s3.test.ts`

**Pattern**:
```typescript
// Uses Cloudflare's test utilities
import { env, createExecutionContext } from 'cloudflare:test'

test('operation', async () => {
  const worker = new Worker()
  const response = await worker.fetch(request, env, ctx)
  expect(response.status).toBe(200)
})
```

**DO Testing**:
- Each test gets isolated DO instance
- Use `env.S3_DO.get(id)` to get DO stub
- Call `.fetch()` on stub to simulate requests

---

## Development Workflow

### Local Development

```bash
# Install dependencies
bun install

# Start dev server (Pages + Worker)
bun run dev

# Type checking (watch mode)
bun run typecheck --watch

# Run tests
bun run test
```

### Deployment

```bash
# Deploy Worker
npx wrangler deploy

# Deploy Pages (via GitHub integration)
git push origin main
```

---

## Known Limitations

### Current Constraints

1. **No folder operations**: Can only move/delete individual files
2. **No multi-select**: Can only drag one file at a time  
3. **No undo/redo**: File operations are immediate and permanent
4. **No conflict resolution**: Moving to existing filename will overwrite
5. **Container token renewal**: 24-hour tokens don't auto-refresh
6. **No collaborative editing**: Single-user environment

### Future Improvements

1. **Recursive folder operations** - Move/delete entire directories
2. **Multi-file selection** - Drag multiple files at once
3. **Drag from desktop** - Upload files via drag & drop
4. **Operation history** - Undo/redo for file operations
5. **Conflict resolution** - Prompt on filename collisions
6. **Real-time collaboration** - Multiple users editing same environment
7. **Persistent folder state** - Remember open folders across sessions

---

## Debugging Tips

### Console Logging

**Current State**: Extensive debug logging in `moveFileInTree()` and drag handlers.

**Production**: Remove console.logs before shipping.

### React DevTools

- Inspect `fileTree` state in Computer route
- Check `fileCacheRef.current` for cache contents
- Monitor `treeOpenState` to debug folder expansion

### Network Inspector

- Watch S3 API calls (GET/PUT/DELETE)
- Check Authorization headers contain JWT
- Verify JWT payload with jwt.io

### Common Errors

**"Unauthorized" (401)**:
- JWT expired (frontend: refresh token, container: restart)
- Computer name mismatch in JWT payload
- Invalid JWT signature (wrong secret)

**"File not found" (404)**:
- Path mismatch (check trailing slashes)
- File not uploaded to S3 yet
- Wrong computer name or DO ID

**UI not updating**:
- State mutation instead of immutable update
- Missing `key` prop in list rendering
- Forgot to call state setter

---

## Key Files Reference

### Frontend
- `app/routes/computer.$name.tsx` - Main computer view, file operations
- `app/components/FileTree.tsx` - File tree UI, drag & drop
- `app/components/CodeEditor.tsx` - Monaco editor wrapper
- `app/lib/s3.ts` - S3 API client, JWT creation
- `app/lib/file-tree.ts` - Tree transformation functions

### Backend
- `worker/index.ts` - Worker entry point, routing
- `worker/computers.ts` - Computer Durable Object
- `worker/s3.ts` - S3 Durable Object, storage
- `worker/lib/jwt.ts` - JWT utilities

### Config
- `wrangler.jsonc` - Worker configuration
- `tsconfig.json` - TypeScript config (frontend)
- `tsconfig.cloudflare.json` - TypeScript config (worker)
- `vite.config.ts` - Vite build config

---

## Questions for Humans

When unsure about architectural decisions:

1. **Batching operations**: Should folder moves be single API call or recursive?
2. **Progress indicators**: Show progress for large file operations?
3. **Persistence**: Store folder open state in localStorage?
4. **Keyboard navigation**: Add keyboard shortcuts for file tree?
5. **Conflict handling**: Prompt before overwriting existing files?

---

## Contributing

### Code Style

- **TypeScript**: Strict mode enabled
- **Formatting**: Prettier (check `.prettierrc`)
- **Naming**: camelCase for functions, PascalCase for components
- **Imports**: Absolute paths preferred (`~/components/...`)

### Git Workflow

- **Commits**: Descriptive messages explaining "why", not "what"
- **Branches**: Feature branches for new work
- **PRs**: Include summary of changes and motivation

### Documentation

- Update this file when adding new patterns
- Add JSDoc comments for complex functions
- Keep SESSION_CONTINUATION.md updated with recent changes

---

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Durable Objects Docs](https://developers.cloudflare.com/durable-objects/)
- [Monaco Editor API](https://microsoft.github.io/monaco-editor/api/index.html)
- [react-arborist Docs](https://github.com/brimdata/react-arborist)

---

**Last Updated**: December 19, 2025  
**Maintainer**: Project contributors  
**For**: AI coding agents and human developers
