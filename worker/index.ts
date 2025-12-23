import { createRequestHandler } from "react-router";
import { Container } from "@cloudflare/containers";
import { S3 } from "./s3";
import { Computers, type Computer } from "./computers";
import { signToken } from "./lib/jwt";
import { Logs } from "./logs";

export { S3, Computers, Logs };

// Helper to smuggle environment variables through request headers
const CONTAINER_ENV_HEADER = "X-Container-Env";

function setContainerEnv(
  request: Request,
  envVars: Record<string, string>
): Request {
  const newRequest = new Request(request.url, request);
  for (const [key, value] of request.headers.entries()) {
    newRequest.headers.set(key, value);
  }
  newRequest.headers.set(CONTAINER_ENV_HEADER, JSON.stringify(envVars));
  return newRequest;
}

function getContainerEnv(request: Request): Record<string, string> {
  const header = request.headers.get(CONTAINER_ENV_HEADER);
  if (!header) return {};
  try {
    return JSON.parse(header);
  } catch {
    return {};
  }
}

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
    S3_AUTH_TOKEN: "",
    LOGS_ENDPOINT: "",
    LOGS_TOKEN: "",
  };

  // Override fetch to extract env vars from header and set them
  override async fetch(request: Request): Promise<Response> {
    const envVars = getContainerEnv(request);

    if (Object.keys(envVars).length > 0) {
      this.envVars = { ...this.envVars, ...envVars };

      // Remove the env header before passing to container
      const cleanRequest = new Request(request.url, request);
      cleanRequest.headers.delete(CONTAINER_ENV_HEADER);

      return super.fetch(cleanRequest);
    }

    return super.fetch(request);
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

class Worker {
  constructor(
    private env: Env,
    private ctx: ExecutionContext
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Check path-based routes first
    if (url.pathname.startsWith("/s3-")) {
      return this.handleS3Request(request);
    }
    if (url.pathname.startsWith("/logs/")) {
      return this.handleLogsRequest(request);
    }
    if (url.pathname.startsWith("/ws")) {
      return this.handleWebSocketRequest(request);
    }

    // Check subdomain routing
    const subdomain = this.extractSubdomain(url.hostname);
    if (subdomain && this.isValidSubdomain(url.hostname, subdomain)) {
      return this.handleSubdomainRequest(request, subdomain);
    }

    // Fallback to React Router
    return this.handleReactRouterRequest(request);
  }

  private extractSubdomain(host: string): string | null {
    const hostParts = host.split(".");
    if (hostParts.length > 1) {
      const subdomain = hostParts[0];
      return subdomain !== "localhost" ? subdomain : null;
    }
    return null;
  }

  private isValidSubdomain(hostname: string, subdomain: string): boolean {
    // Exclude special hostnames that shouldn't use subdomain routing
    const excludedHosts = [
      "workers.dev",
      "cute.maxmcd.com",
      "host.lima.internal",
      "host.docker.internal",
    ];

    for (const excluded of excludedHosts) {
      if (hostname.includes(excluded)) {
        return false;
      }
    }

    return subdomain !== "";
  }

  private async getComputerAndToken(
    computerName: string
  ): Promise<{ computer: Computer; token: string }> {
    const computer = await getComputer(this.env, computerName);
    if (!computer) {
      throw new Error("Computer not found");
    }

    const secrets: string[] = JSON.parse(computer.secrets);
    if (secrets.length === 0) {
      throw new Error("No secrets configured");
    }

    const doId = this.env.APP_CONTAINER.idFromName(computerName).toString();
    const token = await signToken(
      {
        sub: computerName,
        bucket: `s3-${doId}`,
        expiresIn: 86400, // 24 hours
      },
      secrets[0]
    );

    return { computer, token };
  }

  private createContainerRequest(
    request: Request,
    computerName: string,
    token: string
  ): Request {
    // For some reason, in dev, the url host doesn't contain the port.
    const hostHeader = request.headers.get("host") || "localhost";
    const protocol = request.headers.get("x-forwarded-proto") || "http";
    const origin = `${protocol}://${hostHeader}`;
    return setContainerEnv(request, {
      S3_AUTH_TOKEN: token,
      LOGS_ENDPOINT: `${origin}/logs/${computerName}`,
      LOGS_TOKEN: token,
    });
  }

  private async handleSubdomainRequest(
    request: Request,
    subdomain: string
  ): Promise<Response> {
    try {
      const { token } = await this.getComputerAndToken(subdomain);
      const stub = this.env.APP_CONTAINER.getByName(subdomain);
      const requestWithEnv = this.createContainerRequest(
        request,
        subdomain,
        token
      );
      return stub.fetch(requestWithEnv);
    } catch (error) {
      if (error instanceof Error && error.message === "Computer not found") {
        return createComputerNotFoundPage(subdomain);
      }
      return new Response(
        error instanceof Error ? error.message : "Internal server error",
        { status: 500 }
      );
    }
  }

  private async handleS3Request(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/([^\/]+)/);
    if (!pathMatch) {
      return new Response("Invalid S3 path", { status: 400 });
    }
    const bucket = pathMatch[1].slice(4);
    return this.env.S3.getByName(bucket).fetch(request);
  }

  private async handleLogsRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter((p) => p);
    if (pathParts.length < 2) {
      return new Response("Invalid logs path", { status: 400 });
    }
    const computerName = pathParts[1];

    // Rewrite URL path to remove /logs/:name prefix
    // e.g., /logs/foo-boo/write -> /write
    const remainingPath = pathParts.slice(2).join("/");
    const newPath = remainingPath ? `/${remainingPath}` : "/";

    const logsUrl = new URL(request.url);
    logsUrl.pathname = newPath;

    // Forward to Logs DO with rewritten path
    const logsRequest = new Request(logsUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    const logsStub = this.env.LOGS.getByName(computerName);
    return logsStub.fetch(logsRequest);
  }

  private async handleWebSocketRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const computerName = url.searchParams.get("name") || "default";

    try {
      const { token } = await this.getComputerAndToken(computerName);
      const requestWithEnv = this.createContainerRequest(
        request,
        computerName,
        token
      );
      return this.env.APP_CONTAINER.getByName(computerName).fetch(
        requestWithEnv
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Computer not found") {
        return new Response("Computer not found", { status: 404 });
      }
      return new Response(
        error instanceof Error ? error.message : "Internal server error",
        { status: 500 }
      );
    }
  }

  private handleReactRouterRequest(request: Request): Promise<Response> {
    return requestHandler(request, {
      cloudflare: { env: this.env, ctx: this.ctx },
    });
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    new Worker(env, ctx).fetch(request),
};
