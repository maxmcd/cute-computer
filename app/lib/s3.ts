// S3 API utilities - parses XML responses directly without AWS SDK

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
}

/**
 * Fetch the Durable Object ID for a computer
 */
export async function fetchDurableObjectId(computerName: string): Promise<string> {
  const response = await fetch(`/api/computer/${computerName}/do-id`);
  if (!response.ok) {
    throw new Error(`Failed to fetch DO ID: ${response.statusText}`);
  }
  const data = await response.json() as { durableObjectId: string };
  return data.durableObjectId;
}

/**
 * List objects in an S3 bucket with optional prefix filter
 */
export async function listS3Objects(
  doId: string,
  prefix: string = ""
): Promise<S3Object[]> {
  const bucket = `s3-${doId}`;
  const url = new URL(`/${bucket}/`, window.location.origin);
  url.searchParams.set("list-type", "2");
  if (prefix) {
    url.searchParams.set("prefix", prefix);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to list S3 objects: ${response.statusText}`);
  }

  const xmlText = await response.text();
  return parseS3ListResponse(xmlText);
}

/**
 * Get the content of a file from S3
 */
export async function getS3Object(doId: string, key: string): Promise<string> {
  const bucket = `s3-${doId}`;
  const url = `/${bucket}/${key}`;

  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`File not found: ${key}`);
    }
    throw new Error(`Failed to get S3 object: ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Put (upload/update) a file to S3
 */
export async function putS3Object(
  doId: string,
  key: string,
  content: string
): Promise<void> {
  const bucket = `s3-${doId}`;
  const url = `/${bucket}/${key}`;

  const response = await fetch(url, {
    method: "PUT",
    body: content,
    headers: {
      "Content-Type": "text/plain",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to put S3 object: ${response.statusText}`);
  }
}

/**
 * Parse S3 ListBucketResult XML response into an array of objects
 */
function parseS3ListResponse(xmlText: string): S3Object[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "text/xml");

  // Check for XML parsing errors
  const parserError = xmlDoc.querySelector("parsererror");
  if (parserError) {
    throw new Error(`Failed to parse S3 XML response: ${parserError.textContent}`);
  }

  const contents = xmlDoc.querySelectorAll("Contents");
  const objects: S3Object[] = [];

  contents.forEach((content) => {
    const key = content.querySelector("Key")?.textContent || "";
    const sizeText = content.querySelector("Size")?.textContent || "0";
    const size = parseInt(sizeText, 10);
    const lastModified = content.querySelector("LastModified")?.textContent || "";
    const etag = content.querySelector("ETag")?.textContent?.replace(/"/g, "") || "";

    // Include all keys, including directory markers (keys ending with /)
    // Directory markers represent empty folders
    objects.push({ key, size, lastModified, etag });
  });

  return objects;
}
