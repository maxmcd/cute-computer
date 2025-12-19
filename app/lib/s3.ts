// S3 API utilities - parses XML responses directly without AWS SDK

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
}

interface S3Credentials {
  doId: string;
  token: string;
  expiresAt: number;
  displayName: string;
}

// Token cache (per computer)
const tokenCache = new Map<string, S3Credentials>();

/**
 * Fetch credentials (DO ID and JWT token) for a computer
 */
async function getCredentials(computerName: string): Promise<S3Credentials> {
  // Check cache
  const cached = tokenCache.get(computerName);
  if (cached && cached.expiresAt > Date.now() + 60000) { // 1 min buffer
    // Ensure cached credentials have displayName (for backward compat)
    if (!cached.displayName) {
      // Re-fetch if cached entry is missing displayName
      tokenCache.delete(computerName);
    } else {
      return cached;
    }
  }

  // Fetch new credentials
  const response = await fetch(`/api/computer/${computerName}/do-id`);
  if (!response.ok) {
    throw new Error(`Failed to fetch credentials: ${response.statusText}`);
  }
  
  const data = await response.json() as { 
    durableObjectId: string; 
    token: string;
    expiresIn: number;
    computerDisplayName: string;
  };
  
  const credentials = {
    doId: data.durableObjectId,
    token: data.token,
    expiresAt: Date.now() + (data.expiresIn * 1000) - 60000,
    displayName: data.computerDisplayName,
  };
  
  tokenCache.set(computerName, credentials);
  return credentials;
}

/**
 * Fetch the Durable Object ID for a computer (backward compat)
 */
export async function fetchDurableObjectId(computerName: string): Promise<string> {
  const creds = await getCredentials(computerName);
  return creds.doId;
}

/**
 * Fetch computer details (DO ID and display name)
 */
export async function fetchComputerDetails(computerName: string): Promise<{ doId: string; displayName: string }> {
  const creds = await getCredentials(computerName);
  return { doId: creds.doId, displayName: creds.displayName };
}

/**
 * List objects in an S3 bucket with optional prefix filter
 */
export async function listS3Objects(
  computerName: string,
  doId: string,
  prefix: string = ""
): Promise<S3Object[]> {
  const creds = await getCredentials(computerName);
  const bucket = `s3-${doId}`;
  const url = new URL(`/${bucket}/`, window.location.origin);
  url.searchParams.set("list-type", "2");
  if (prefix) {
    url.searchParams.set("prefix", prefix);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${creds.token}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to list S3 objects: ${response.statusText}`);
  }

  const xmlText = await response.text();
  return parseS3ListResponse(xmlText);
}

/**
 * Get the content of a file from S3
 */
export async function getS3Object(computerName: string, doId: string, key: string): Promise<string> {
  const creds = await getCredentials(computerName);
  const bucket = `s3-${doId}`;
  const url = `/${bucket}/${key}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${creds.token}`,
    },
  });
  
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
  computerName: string,
  doId: string,
  key: string,
  content: string
): Promise<void> {
  const creds = await getCredentials(computerName);
  const bucket = `s3-${doId}`;
  const url = `/${bucket}/${key}`;

  const response = await fetch(url, {
    method: "PUT",
    body: content,
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Bearer ${creds.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to put S3 object: ${response.statusText}`);
  }
}

/**
 * Delete a file from S3
 */
export async function deleteS3Object(
  computerName: string,
  doId: string,
  key: string
): Promise<void> {
  const creds = await getCredentials(computerName);
  const bucket = `s3-${doId}`;
  const url = `/${bucket}/${key}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${creds.token}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete S3 object: ${response.statusText}`);
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
