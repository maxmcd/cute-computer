import { env } from "cloudflare:test";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { describe, it, expect } from "vitest";
import { DOMParser } from "@xmldom/xmldom";

// Polyfill DOMParser and Node constants for AWS SDK XML parsing
globalThis.DOMParser = DOMParser as any;
globalThis.Node = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  CDATA_SECTION_NODE: 4,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
} as any;

function createS3Client(bucketName: string): S3Client {
  const id = env.S3.idFromName(bucketName);
  const stub = env.S3.get(id);

  return new S3Client({
    endpoint: "http://test",
    region: "auto",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
    forcePathStyle: true, // Important: use path-style addressing (bucket in path)
    // Use stub.fetch as the request handler
    requestHandler: {
      handle: async (request: any) => {
        const query = request.query ? `?${new URLSearchParams(request.query).toString()}` : '';
        const url = `http://test${request.path}${query}`;

        const fetchRequest = new Request(url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });

        const response = await stub.fetch(fetchRequest);

        return {
          response: {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: response.body,
          },
        };
      },
    },
  });
}

describe("S3 with AWS SDK", () => {
  it("can PUT and GET an object using AWS S3 SDK", async () => {
    const s3Client = createS3Client("test-instance");

    const bucket = "test-bucket";
    const key = "test-file.txt";
    const content = "Hello from AWS SDK!";

    // PUT object
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: content })
    );

    // GET object
    const getResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    const bodyText = await getResult.Body?.transformToString();
    expect(bodyText).toBe(content);
  });

  it("can PUT and GET an empty file", async () => {
    const s3Client = createS3Client("test-instance");

    const bucket = "empty-test-bucket";
    const key = "empty.txt";

    const putResult = await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: "" })
    );
    expect(putResult.$metadata.httpStatusCode).toBe(200);
    expect(putResult.ETag).toBeTruthy();

    const getResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    expect(getResult.$metadata.httpStatusCode).toBe(200);
    expect(getResult.ContentLength).toBe(0);

    const bodyText = await getResult.Body?.transformToString();
    expect(bodyText).toBe("");
  });

  it("can HEAD an object", async () => {
    const s3Client = createS3Client("head-test");
    const bucket = "test-bucket";
    const key = "test.txt";
    const content = "test content";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: content })
    );

    const headResult = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );

    expect(headResult.$metadata.httpStatusCode).toBe(200);
    expect(headResult.ContentLength).toBe(content.length);
    expect(headResult.ETag).toBeTruthy();
  });

  it("can DELETE an object", async () => {
    const s3Client = createS3Client("delete-test");
    const bucket = "test-bucket";
    const key = "delete-me.txt";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: "delete this" })
    );

    const deleteResult = await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key })
    );
    expect(deleteResult.$metadata.httpStatusCode).toBe(204);

    await expect(
      s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    ).rejects.toThrow();
  });

  it("can list objects", async () => {
    const s3Client = createS3Client("list-test");
    const bucket = "test-bucket";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "file1.txt", Body: "data1" })
    );
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "file2.txt", Body: "data2" })
    );
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "dir/file3.txt",
        Body: "data3",
      })
    );

    const listResult = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket })
    );

    expect(listResult.Contents).toHaveLength(3);
    expect(listResult.KeyCount).toBe(3);
    const keys = listResult.Contents?.map((obj) => obj.Key) || [];
    expect(keys.includes("file1.txt")).toBe(true);
    expect(keys.includes("file2.txt")).toBe(true);
    expect(keys.includes("dir/file3.txt")).toBe(true);
  });

  it("can list objects with prefix", async () => {
    const s3Client = createS3Client("prefix-test");
    const bucket = "prefix-bucket";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "foo/a.txt", Body: "a" })
    );
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "foo/b.txt", Body: "b" })
    );
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "bar/c.txt", Body: "c" })
    );

    const listResult = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "foo/" })
    );

    const keys = listResult.Contents?.map((obj) => obj.Key) || [];
    expect(listResult.KeyCount).toBe(2);
    expect(keys.includes("foo/a.txt")).toBe(true);
    expect(keys.includes("foo/b.txt")).toBe(true);
    expect(keys.includes("bar/c.txt")).toBe(false);
  });

  it("can handle large files with chunking", async () => {
    const s3Client = createS3Client("chunk-test");
    const bucket = "test-bucket";
    const key = "large-file.bin";

    const size = 2 * 1024 * 1024;
    const largeData = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      largeData[i] = i % 256;
    }

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: largeData })
    );

    const getResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    expect(getResult.ContentLength).toBe(size);
    const retrieved = await getResult.Body?.transformToByteArray();
    expect(retrieved?.length).toBe(size);
    expect(retrieved?.[0]).toBe(0);
    expect(retrieved?.[size - 1]).toBe((size - 1) % 256);
  });

  it("can create and complete multipart upload", async () => {
    const s3Client = createS3Client("multipart-test");
    const bucket = "test-bucket";
    const key = "multipart-file.txt";

    const createResult = await s3Client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
    );
    const uploadId = createResult.UploadId!;
    expect(uploadId).toBeTruthy();

    const part1Data = "part 1 data";
    const part1Result = await s3Client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: part1Data,
      })
    );

    const part2Data = "part 2 data";
    const part2Result = await s3Client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 2,
        Body: part2Data,
      })
    );

    await s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: part1Result.ETag },
            { PartNumber: 2, ETag: part2Result.ETag },
          ],
        },
      })
    );

    const getResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    const content = await getResult.Body?.transformToString();
    expect(content).toBe(part1Data + part2Data);
  });

  it("can abort multipart upload", async () => {
    const s3Client = createS3Client("abort-test");
    const bucket = "test-bucket";
    const key = "aborted-file.txt";

    const createResult = await s3Client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
    );
    const uploadId = createResult.UploadId!;

    await s3Client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: "test data",
      })
    );

    const abortResult = await s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      })
    );
    expect(abortResult.$metadata.httpStatusCode).toBe(204);

    await expect(
      s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    ).rejects.toThrow();
  });

  it("returns 404 for non-existent object", async () => {
    const s3Client = createS3Client("not-found-test");

    await expect(
      s3Client.send(
        new GetObjectCommand({
          Bucket: "test-bucket",
          Key: "does-not-exist.txt",
        })
      )
    ).rejects.toThrow();
  });

  it("handles keys with special characters and URL encoding", async () => {
    const s3Client = createS3Client("special-chars-test");
    const bucket = "test-bucket";
    const key = "path/to/file with spaces & special-chars!.txt";
    const content = "special content";

    // PUT object (SDK will URL-encode the key in the request)
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: content })
    );

    // GET object (SDK will URL-encode the key in the request)
    const getResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    const retrieved = await getResult.Body?.transformToString();
    expect(retrieved).toBe(content);

    // List objects to verify the key is stored decoded (not URL-encoded)
    const listResult = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket })
    );
    const keys = listResult.Contents?.map((obj) => obj.Key) || [];
    expect(keys.length).toBe(1);
    expect(keys[0]).toBe(key); // Should be decoded, with actual spaces and special chars
    // Verify no URL encoding in the stored key
    expect(keys[0]?.includes("%20")).toBe(false); // Should NOT contain URL-encoded space
    expect(keys[0]?.includes("%26")).toBe(false); // Should NOT contain URL-encoded &
    expect(keys[0]?.includes("%21")).toBe(false); // Should NOT contain URL-encoded !
  });

  it("preserves trailing slashes in keys for directory markers", async () => {
    const s3Client = createS3Client("trailing-slash-test");
    const bucket = "test-bucket";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "foo", Body: "file content" })
    );

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "foo/", Body: "" })
    );

    const listResult = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket })
    );

    const keys = listResult.Contents?.map((obj) => obj.Key) || [];
    expect(keys).toHaveLength(2);
    expect(keys.includes("foo")).toBe(true);
    expect(keys.includes("foo/")).toBe(true);
  });

  it("can GET directory markers with trailing slash", async () => {
    const s3Client = createS3Client("dir-marker-test");
    const bucket = "test-bucket";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "dir/", Body: "" })
    );

    const getResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: "dir/" })
    );

    expect(getResult.ContentLength).toBe(0);

    const headResult = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: "dir/" })
    );

    expect(headResult.ContentLength).toBe(0);
  });

  it("can DELETE directory markers with trailing slash", async () => {
    const s3Client = createS3Client("delete-dir-test");
    const bucket = "test-bucket";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "mydir/", Body: "" })
    );

    const deleteResult = await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: "mydir/" })
    );
    expect(deleteResult.$metadata.httpStatusCode).toBe(204);

    await expect(
      s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: "mydir/" }))
    ).rejects.toThrow();
  });

  it("treats foo and foo/ as distinct keys", async () => {
    const s3Client = createS3Client("distinct-keys-test");
    const bucket = "test-bucket";
    const fileContent = "this is a file";
    const dirContent = "";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "item", Body: fileContent })
    );
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "item/", Body: dirContent })
    );

    const fileResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: "item" })
    );
    const fileBody = await fileResult.Body?.transformToString();
    expect(fileBody).toBe(fileContent);

    const dirResult = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: "item/" })
    );
    const dirBody = await dirResult.Body?.transformToString();
    expect(dirBody).toBe(dirContent);

    await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: "item" })
    );

    const listResult = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket })
    );
    const keys = listResult.Contents?.map((obj) => obj.Key) || [];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("item/");
  });

  it("lists directory structure with nested paths and trailing slashes", async () => {
    const s3Client = createS3Client("nested-dir-test");
    const bucket = "test-bucket";

    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "a/", Body: "" })
    );
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "a/b/", Body: "" })
    );
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "a/b/file.txt", Body: "data" })
    );
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "a/file2.txt", Body: "data2" })
    );

    const listResult = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket })
    );

    const keys = listResult.Contents?.map((obj) => obj.Key) || [];
    expect(keys).toHaveLength(4);
    expect(keys.includes("a/")).toBe(true);
    expect(keys.includes("a/b/")).toBe(true);
    expect(keys.includes("a/b/file.txt")).toBe(true);
    expect(keys.includes("a/file2.txt")).toBe(true);
  });
});
