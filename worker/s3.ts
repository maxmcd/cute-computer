import { DurableObject } from "cloudflare:workers";

interface S3Object {
  bucket: string;
  key: string;
  data: ArrayBuffer;
  size: number;
  etag: string;
  last_modified: string;
  content_type: string;
}

const CHUNK_SIZE = 1024 * 1024; // 1MB chunks to stay under 2MB SQLite limit

export class S3 extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;

    // Objects table: chunk_index 0 has metadata, rest have empty strings
    this.sql.exec(`CREATE TABLE IF NOT EXISTS objects (
      bucket TEXT NOT NULL,
      key TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      size INTEGER NOT NULL,
      etag TEXT NOT NULL,
      last_modified TEXT NOT NULL,
      content_type TEXT NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (bucket, key, chunk_index)
    )`);

    // Multipart uploads metadata table
    this.sql.exec(`CREATE TABLE IF NOT EXISTS multipart_uploads (
      upload_id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_type TEXT NOT NULL
    )`);

    // Multipart parts table: chunk_index 0 has metadata, rest have empty strings
    this.sql.exec(`CREATE TABLE IF NOT EXISTS multipart_parts (
      upload_id TEXT NOT NULL,
      part_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      size INTEGER NOT NULL,
      etag TEXT NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (upload_id, part_number, chunk_index)
    )`);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const method = request.method;

    // Parse path-style URL: /bucket/key or /bucket?list-type=2
    const pathParts = url.pathname.split("/").filter((p) => p.length > 0);

    if (pathParts.length === 0) {
      return this.errorResponse("NoSuchBucket", "No bucket specified", 404);
    }

    const bucket = pathParts[0];
    const key = pathParts.slice(1).join("/");

    // HEAD bucket (check if bucket exists)
    if (method === "HEAD" && !key) {
      return this.headBucket(bucket);
    }

    // GET bucket (list objects) - supports both ListObjectsV2 and ListObjects
    if (method === "GET" && !key) {
      return this.listObjectsV2(bucket, url.searchParams);
    }

    // GetObject or HeadObject
    if ((method === "GET" || method === "HEAD") && key) {
      return this.getObject(bucket, key, method === "HEAD");
    }

    // Multipart upload operations
    if (key) {
      const uploadId = url.searchParams.get("uploadId");

      // CreateMultipartUpload (POST with ?uploads)
      if (method === "POST" && url.searchParams.has("uploads")) {
        return this.createMultipartUpload(bucket, key, request);
      }

      // UploadPart (PUT with ?uploadId&partNumber)
      if (method === "PUT" && uploadId && url.searchParams.has("partNumber")) {
        const partNumber = parseInt(url.searchParams.get("partNumber")!);
        return this.uploadPart(bucket, key, uploadId, partNumber, request);
      }

      // CompleteMultipartUpload (POST with ?uploadId)
      if (method === "POST" && uploadId) {
        return this.completeMultipartUpload(bucket, key, uploadId, request);
      }

      // AbortMultipartUpload (DELETE with ?uploadId)
      if (method === "DELETE" && uploadId) {
        return this.abortMultipartUpload(uploadId);
      }
    }

    // PutObject
    if (method === "PUT" && key) {
      return this.putObject(bucket, key, request);
    }

    // DeleteObject
    if (method === "DELETE" && key) {
      return this.deleteObject(bucket, key);
    }

    return this.errorResponse(
      "NotImplemented",
      "Operation not implemented",
      501,
    );
  }

  private async putObject(
    bucket: string,
    key: string,
    request: Request,
  ): Promise<Response> {
    try {
      const data = await request.arrayBuffer();
      const size = data.byteLength;
      const contentType =
        request.headers.get("content-type") || "application/octet-stream";

      // Generate ETag (MD5 hash)
      const hashBuffer = await crypto.subtle.digest("MD5", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const etag = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const lastModified = new Date().toISOString();

      // Delete existing object if any
      this.sql.exec(
        `DELETE FROM objects WHERE bucket = ? AND key = ?`,
        bucket,
        key,
      );

      // Store data in chunks
      const dataArray = new Uint8Array(data);
      
      // Always insert chunk 0 with metadata (even if empty)
      this.sql.exec(
        `INSERT INTO objects (bucket, key, chunk_index, size, etag, last_modified, content_type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        bucket,
        key,
        0,
        size,
        etag,
        lastModified,
        contentType,
        size === 0 ? new ArrayBuffer(0) : dataArray.slice(0, Math.min(CHUNK_SIZE, size)).buffer,
      );

      // If file is larger than one chunk, store remaining chunks
      if (size > CHUNK_SIZE) {
        let chunkIndex = 1;
        for (let offset = CHUNK_SIZE; offset < size; offset += CHUNK_SIZE) {
          const chunkEnd = Math.min(offset + CHUNK_SIZE, size);
          const chunk = dataArray.slice(offset, chunkEnd);
          
          this.sql.exec(
            `INSERT INTO objects (bucket, key, chunk_index, size, etag, last_modified, content_type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            bucket,
            key,
            chunkIndex,
            0,
            "",
            "",
            "",
            chunk.buffer,
          );
          chunkIndex++;
        }
      }

      return new Response(null, {
        status: 200,
        headers: {
          ETag: `"${etag}"`,
          "x-amz-request-id": crypto.randomUUID(),
        },
      });
    } catch (error) {
      console.error("PutObject error:", error);
      return this.errorResponse("InternalError", "Failed to store object", 500);
    }
  }

  private async getObject(
    bucket: string,
    key: string,
    headOnly: boolean,
  ): Promise<Response> {
    try {
      // Get metadata from chunk 0
      const result = this.sql.exec(
        `SELECT size, etag, last_modified, content_type FROM objects WHERE bucket = ? AND key = ? AND chunk_index = 0`,
        bucket,
        key,
      );

      const rows = [...result];
      if (rows.length === 0) {
        return this.errorResponse(
          "NoSuchKey",
          "The specified key does not exist.",
          404,
        );
      }

      const row = rows[0] as any;
      const headers: Record<string, string> = {
        "Content-Type": row.content_type,
        "Content-Length": row.size.toString(),
        ETag: `"${row.etag}"`,
        "Last-Modified": new Date(row.last_modified).toUTCString(),
        "x-amz-request-id": crypto.randomUUID(),
      };

      if (headOnly) {
        return new Response(null, { status: 200, headers });
      }

      // Read all chunks
      const chunksResult = this.sql.exec(
        `SELECT data FROM objects WHERE bucket = ? AND key = ? ORDER BY chunk_index`,
        bucket,
        key,
      );
      const chunks = [...chunksResult] as any[];

      if (chunks.length === 0) {
        // Empty file
        return new Response(new ArrayBuffer(0), { status: 200, headers });
      }

      // Combine chunks
      const totalSize = row.size;
      const combinedData = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        const chunkData = new Uint8Array(chunk.data);
        combinedData.set(chunkData, offset);
        offset += chunkData.byteLength;
      }

      return new Response(combinedData.buffer, { status: 200, headers });
    } catch (error) {
      console.error("GetObject error:", error);
      return this.errorResponse(
        "InternalError",
        "Failed to retrieve object",
        500,
      );
    }
  }

  private async deleteObject(bucket: string, key: string): Promise<Response> {
    try {
      this.sql.exec(
        `DELETE FROM objects WHERE bucket = ? AND key = ?`,
        bucket,
        key,
      );

      return new Response(null, {
        status: 204,
        headers: {
          "x-amz-request-id": crypto.randomUUID(),
        },
      });
    } catch (error) {
      console.error("DeleteObject error:", error);
      return this.errorResponse(
        "InternalError",
        "Failed to delete object",
        500,
      );
    }
  }

  private async headBucket(bucket: string): Promise<Response> {
    // For now, we'll just return success for any bucket
    // In a real implementation, you might want to check if the bucket has any objects
    return new Response(null, {
      status: 200,
      headers: {
        "x-amz-request-id": crypto.randomUUID(),
      },
    });
  }

  private async listObjectsV2(
    bucket: string,
    params: URLSearchParams,
  ): Promise<Response> {
    try {
      const prefix = params.get("prefix") || "";
      const delimiter = params.get("delimiter") || "";
      const maxKeys = parseInt(params.get("max-keys") || "1000");
      const startAfter = params.get("start-after") || "";
      const continuationToken = params.get("continuation-token") || "";

      let query = `SELECT key, size, etag, last_modified FROM objects WHERE bucket = ? AND chunk_index = 0`;
      const queryParams: any[] = [bucket];

      if (prefix) {
        query += ` AND key LIKE ?`;
        queryParams.push(`${prefix}%`);
      }

      if (continuationToken || startAfter) {
        query += ` AND key > ?`;
        queryParams.push(continuationToken || startAfter);
      }

      query += ` ORDER BY key LIMIT ?`;
      queryParams.push(maxKeys + 1); // Get one extra to determine if truncated

      const result = this.sql.exec(query, ...queryParams);
      const rows = [...result] as any[];

      const isTruncated = rows.length > maxKeys;
      const objects = rows.slice(0, maxKeys);

      let nextContinuationToken = "";
      if (isTruncated && objects.length > 0) {
        nextContinuationToken = objects[objects.length - 1].key; // last key
      }

      // Build XML response
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      xml +=
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n';
      xml += `  <Name>${this.escapeXml(bucket)}</Name>\n`;
      xml += `  <Prefix>${this.escapeXml(prefix)}</Prefix>\n`;
      xml += `  <KeyCount>${objects.length}</KeyCount>\n`;
      xml += `  <MaxKeys>${maxKeys}</MaxKeys>\n`;
      xml += `  <IsTruncated>${isTruncated}</IsTruncated>\n`;

      if (nextContinuationToken) {
        xml += `  <NextContinuationToken>${this.escapeXml(nextContinuationToken)}</NextContinuationToken>\n`;
      }

      for (const row of objects) {
        xml += "  <Contents>\n";
        xml += `    <Key>${this.escapeXml(row.key)}</Key>\n`;
        xml += `    <LastModified>${new Date(row.last_modified).toISOString()}</LastModified>\n`;
        xml += `    <ETag>"${this.escapeXml(row.etag)}"</ETag>\n`;
        xml += `    <Size>${row.size}</Size>\n`;
        xml += `    <StorageClass>STANDARD</StorageClass>\n`;
        xml += "  </Contents>\n";
      }

      xml += "</ListBucketResult>";

      return new Response(xml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml",
          "x-amz-request-id": crypto.randomUUID(),
        },
      });
    } catch (error) {
      console.error("ListObjectsV2 error:", error);
      return this.errorResponse("InternalError", "Failed to list objects", 500);
    }
  }

  private async createMultipartUpload(
    bucket: string,
    key: string,
    request: Request,
  ): Promise<Response> {
    try {
      const uploadId = crypto.randomUUID();
      const contentType =
        request.headers.get("content-type") || "application/octet-stream";
      const createdAt = new Date().toISOString();

      this.sql.exec(
        `INSERT INTO multipart_uploads (upload_id, bucket, key, created_at, content_type) VALUES (?, ?, ?, ?, ?)`,
        uploadId,
        bucket,
        key,
        createdAt,
        contentType,
      );

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${this.escapeXml(bucket)}</Bucket>
  <Key>${this.escapeXml(key)}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`;

      return new Response(xml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml",
          "x-amz-request-id": crypto.randomUUID(),
        },
      });
    } catch (error) {
      console.error("CreateMultipartUpload error:", error);
      return this.errorResponse(
        "InternalError",
        "Failed to create multipart upload",
        500,
      );
    }
  }

  private async uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    request: Request,
  ): Promise<Response> {
    try {
      const data = await request.arrayBuffer();
      const size = data.byteLength;

      // Generate ETag (MD5 hash)
      const hashBuffer = await crypto.subtle.digest("MD5", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const etag = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Delete existing chunks for this part if any
      this.sql.exec(
        `DELETE FROM multipart_parts WHERE upload_id = ? AND part_number = ?`,
        uploadId,
        partNumber,
      );

      // Store data in chunks
      const dataArray = new Uint8Array(data);
      
      // Always insert chunk 0 with metadata (even if empty)
      this.sql.exec(
        `INSERT INTO multipart_parts (upload_id, part_number, chunk_index, size, etag, data) VALUES (?, ?, ?, ?, ?, ?)`,
        uploadId,
        partNumber,
        0,
        size,
        etag,
        size === 0 ? new ArrayBuffer(0) : dataArray.slice(0, Math.min(CHUNK_SIZE, size)).buffer,
      );

      // If part is larger than one chunk, store remaining chunks
      if (size > CHUNK_SIZE) {
        let chunkIndex = 1;
        for (let offset = CHUNK_SIZE; offset < size; offset += CHUNK_SIZE) {
          const chunkEnd = Math.min(offset + CHUNK_SIZE, size);
          const chunk = dataArray.slice(offset, chunkEnd);
          
          this.sql.exec(
            `INSERT INTO multipart_parts (upload_id, part_number, chunk_index, size, etag, data) VALUES (?, ?, ?, ?, ?, ?)`,
            uploadId,
            partNumber,
            chunkIndex,
            0,
            "",
            chunk.buffer,
          );
          chunkIndex++;
        }
      }

      return new Response(null, {
        status: 200,
        headers: {
          ETag: `"${etag}"`,
          "x-amz-request-id": crypto.randomUUID(),
        },
      });
    } catch (error) {
      console.error("UploadPart error:", error);
      return this.errorResponse("InternalError", "Failed to upload part", 500);
    }
  }

  private async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    request: Request,
  ): Promise<Response> {
    try {
      // Get upload metadata
      const uploadResult = this.sql.exec(
        `SELECT content_type FROM multipart_uploads WHERE upload_id = ?`,
        uploadId,
      );
      const uploads = [...uploadResult] as any[];

      if (uploads.length === 0) {
        return this.errorResponse(
          "NoSuchUpload",
          "The specified upload does not exist",
          404,
        );
      }

      const contentType = uploads[0].content_type;

      // Get all parts metadata (chunk 0 only), ordered by part number
      const partsResult = this.sql.exec(
        `SELECT part_number, size, etag FROM multipart_parts WHERE upload_id = ? AND chunk_index = 0 ORDER BY part_number`,
        uploadId,
      );
      const parts = [...partsResult] as any[];

      if (parts.length === 0) {
        return this.errorResponse("InvalidPart", "No parts were uploaded", 400);
      }

      // Calculate total size
      let totalSize = 0;
      for (const part of parts) {
        totalSize += part.size;
      }

      // Delete existing object if any
      this.sql.exec(
        `DELETE FROM objects WHERE bucket = ? AND key = ?`,
        bucket,
        key,
      );

      // Copy part chunks to object chunks, re-indexing them
      let objectChunkIndex = 0;
      const lastModified = new Date().toISOString();
      const etag = `${crypto.randomUUID().replace(/-/g, "")}-${parts.length}`;

      for (const part of parts) {
        const partChunksResult = this.sql.exec(
          `SELECT data FROM multipart_parts WHERE upload_id = ? AND part_number = ? ORDER BY chunk_index`,
          uploadId,
          part.part_number,
        );
        const partChunks = [...partChunksResult] as any[];

        for (const chunk of partChunks) {
          // First chunk (index 0) has metadata, rest have empty strings
          if (objectChunkIndex === 0) {
            this.sql.exec(
              `INSERT INTO objects (bucket, key, chunk_index, size, etag, last_modified, content_type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              bucket,
              key,
              objectChunkIndex,
              totalSize,
              etag,
              lastModified,
              contentType,
              chunk.data,
            );
          } else {
            this.sql.exec(
              `INSERT INTO objects (bucket, key, chunk_index, size, etag, last_modified, content_type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              bucket,
              key,
              objectChunkIndex,
              0,
              "",
              "",
              "",
              chunk.data,
            );
          }
          objectChunkIndex++;
        }
      }

      // Clean up multipart upload data
      this.sql.exec(
        `DELETE FROM multipart_parts WHERE upload_id = ?`,
        uploadId,
      );
      this.sql.exec(
        `DELETE FROM multipart_uploads WHERE upload_id = ?`,
        uploadId,
      );

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>http://localhost:8787/${this.escapeXml(bucket)}/${this.escapeXml(key)}</Location>
  <Bucket>${this.escapeXml(bucket)}</Bucket>
  <Key>${this.escapeXml(key)}</Key>
  <ETag>"${etag}"</ETag>
</CompleteMultipartUploadResult>`;

      return new Response(xml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml",
          "x-amz-request-id": crypto.randomUUID(),
        },
      });
    } catch (error) {
      console.error("CompleteMultipartUpload error:", error);
      return this.errorResponse(
        "InternalError",
        "Failed to complete multipart upload",
        500,
      );
    }
  }

  private async abortMultipartUpload(uploadId: string): Promise<Response> {
    try {
      this.sql.exec(
        `DELETE FROM multipart_parts WHERE upload_id = ?`,
        uploadId,
      );
      this.sql.exec(
        `DELETE FROM multipart_uploads WHERE upload_id = ?`,
        uploadId,
      );

      return new Response(null, {
        status: 204,
        headers: {
          "x-amz-request-id": crypto.randomUUID(),
        },
      });
    } catch (error) {
      console.error("AbortMultipartUpload error:", error);
      return this.errorResponse(
        "InternalError",
        "Failed to abort multipart upload",
        500,
      );
    }
  }

  private errorResponse(
    code: string,
    message: string,
    status: number,
  ): Response {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${this.escapeXml(code)}</Code>
  <Message>${this.escapeXml(message)}</Message>
  <RequestId>${crypto.randomUUID()}</RequestId>
</Error>`;

    return new Response(xml, {
      status,
      headers: {
        "Content-Type": "application/xml",
        "x-amz-request-id": crypto.randomUUID(),
      },
    });
  }

  private escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}
