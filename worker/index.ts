import { createRequestHandler } from "react-router";
import { Container } from "@cloudflare/containers";
import { S3 } from "./s3";
import { Computers, type Computer } from "./computers";
import { signToken } from "./lib/jwt";

export { S3, Computers };

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export class AppContainer extends Container<Env> {
  // Port the container listens on (default: 8283)
  defaultPort = 8283;
  // Time before container sleeps due to inactivity (default: 30s)
  sleepAfter = "10m";
  // Environment variables passed to the container
  envVars = {
    S3_AUTH_TOKEN: "", // Will be set from request header
  };

  // Override fetch to extract S3 token from header and set env vars
  override async fetch(request: Request): Promise<Response> {
    // Extract S3 auth token from header (set by the worker before routing here)
    const s3Token = request.headers.get("X-S3-Auth-Token");
    
    if (s3Token) {
      // Set the token in environment variables before container starts
      this.envVars.S3_AUTH_TOKEN = s3Token;
      
      // Remove the internal header before passing to container
      const cleanRequest = new Request(request.url, request);
      cleanRequest.headers.delete("X-S3-Auth-Token");
      
      return super.fetch(cleanRequest);
    }
    
    // No token provided, continue normally (shouldn't happen in production)
    return super.fetch(request);
  }

  // Optional lifecycle hooks
  override async onStart() {
    console.log("Container started successfully");
  }

  override onStop() {
    console.log("Container successfully shut down");
  }

  override onError(error: unknown) {
    console.log("Container error:", error);
  }
}

// Helper function to create a beautiful 404 page for non-existent computers
function createComputerNotFoundPage(computerName: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Computer Not Found - Cute Computer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #ffeef8 0%, #e0d4f7 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>404</h1>
        <h2>Computer Not Found</h2>
        <div class="computer-name">${computerName}</div>
        <p class="message">This computer doesn't exist or may have been deleted.</p>
        <a href="/" class="home-link">← Back to Home</a>
    </div>
</body>
</html>`;

  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function getComputer(
  env: Env,
  computerName: string
): Promise<Computer | null> {
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));
  const computer = await computersStub.getComputer(computerName);
  return computer;
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);

    // Extract subdomain from Host header
    // Format: subdomain.domain.tld or subdomain.localhost
    const hostParts = url.host.split(".");
    const subdomain = hostParts.length > 1 ? hostParts[0] : "";

    // If we have a subdomain that isn't "localhost" or the main domain
    // Route to the container by subdomain name
    if (
      !url.host.includes("workers.dev") && // dont expect subdomain stuff on workers.dev
      url.host !== "cute.maxmcd.com" &&
      url.hostname !== "host.lima.internal" &&
      subdomain &&
      subdomain !== "localhost"
    ) {
      // Validate that the computer exists before routing
      const computer = await getComputer(env, subdomain);
      if (!computer) {
        return createComputerNotFoundPage(subdomain);
      }
      
      // Generate JWT token for this computer
      const secrets: string[] = JSON.parse(computer.secrets);
      if (secrets.length === 0) {
        return new Response("No secrets configured for computer", { status: 500 });
      }
      
      const doId = env.APP_CONTAINER.idFromName(subdomain).toString();
      const token = await signToken(
        {
          sub: subdomain,
          bucket: `s3-${doId}`,
          expiresIn: 86400, // 24 hours
        },
        secrets[0]
      );
      
      // Add S3 auth token as header for container to use
      const modifiedRequest = new Request(request.url, request);
      modifiedRequest.headers.set("X-S3-Auth-Token", token);
      
      const stub = env.APP_CONTAINER.getByName(subdomain);
      return stub.fetch(modifiedRequest);
    }

    if (url.pathname.startsWith("/s3-")) {
      const pathMatch = url.pathname.match(/^\/([^\/]+)/);
      if (!pathMatch) {
        return new Response("Invalid S3 path", { status: 400 });
      }
      const bucket = pathMatch[1].slice(4);
      return env.S3.getByName(bucket).fetch(request);
    }
    if (url.pathname.startsWith("/ws")) {
      // Extract computer name from query parameter
      const computerName = url.searchParams.get("name") || "default";

      const computer = await getComputer(env, computerName);
      if (!computer) {
        // For WebSocket connections, return a proper error response
        return new Response("Computer not found", { status: 404 });
      }

      // Generate JWT token for this computer
      const secrets: string[] = JSON.parse(computer.secrets);
      if (secrets.length === 0) {
        return new Response("No secrets configured for computer", { status: 500 });
      }
      
      const doId = env.APP_CONTAINER.idFromName(computerName).toString();
      const token = await signToken(
        {
          sub: computerName,
          bucket: `s3-${doId}`,
          expiresIn: 86400, // 24 hours
        },
        secrets[0]
      );
      
      // Add S3 auth token as header for container to use
      const modifiedRequest = new Request(request.url, request);
      modifiedRequest.headers.set("X-S3-Auth-Token", token);
      
      // Route to container instance by computer name
      return env.APP_CONTAINER.getByName(computerName).fetch(modifiedRequest);
    }

    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
};
