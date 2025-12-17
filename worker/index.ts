import { createRequestHandler } from "react-router";
import { Container } from "@cloudflare/containers";
import { S3 } from "./s3";
import { Computers } from "./computers";

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

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);

    // Extract subdomain from Host header
    // Format: subdomain.domain.tld or subdomain.localhost
    const hostParts = url.host.split(".");
    const subdomain = hostParts.length > 1 ? hostParts[0] : "";

    console.log("Subdomain:", { subdomain, url });

    // If we have a subdomain that isn't "localhost" or the main domain
    // Route to the container by subdomain name
    if (
      !url.host.includes("workers.dev") && // dont expect subdomain stuff on workers.dev
      subdomain &&
      subdomain !== "localhost"
    ) {
      return env.APP_CONTAINER.getByName(subdomain).fetch(request);
    }

    if (url.pathname.startsWith("/foo")) {
      return env.S3.getByName("instance").fetch(request);
    }
    if (url.pathname.startsWith("/ws")) {
      // Extract computer name from query parameter
      const computerName = url.searchParams.get("name") || "default";
      // Route to container instance by computer name
      return env.APP_CONTAINER.getByName(computerName).fetch(request);
    }

    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
};
