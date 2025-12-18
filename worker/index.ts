import { createRequestHandler } from "react-router";
import { Container } from "@cloudflare/containers";
import { S3 } from "./s3";
import { Computers, type Computer } from "./computers";

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
  sleepAfter = "2m";
  // Environment variables passed to the container
  envVars = {
    MESSAGE: "I was passed in via the container class!",
  };

  // Optional lifecycle hooks
  override onStart() {
    console.log("Container successfully started");
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
      subdomain &&
      subdomain !== "localhost"
    ) {
      // Validate that the computer exists before routing
      const computer = await getComputer(env, subdomain);
      if (!computer) {
        return createComputerNotFoundPage(subdomain);
      }
      const stub = env.APP_CONTAINER.getByName(subdomain);
      return stub.fetch(request);
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

      // Route to container instance by computer name
      return env.APP_CONTAINER.getByName(computerName).fetch(request);
    }

    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
};
