import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

export class AppContainer extends Container<Env> {
  // Port the container listens on (default: 8080)
  defaultPort = 8080;
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

export class S3 extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS foo (
		id INTEGER PRIMARY KEY,
		thing BLOB NOT NULL
	)`);
  }

  async fetch(request: Request) {
    return new Response("Hello World!");
  }
}

export default {
  fetch: (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/____container") {
      return env.APP_CONTAINER.getByName("instance").fetch(request);
    }
    return env.S3.getByName("instance").fetch(request);
  },
};
