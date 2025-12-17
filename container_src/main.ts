import { spawn } from "bun";
import fs from "fs";

fs.mkdirSync("/opt/s3", { recursive: true });
const loc = Bun.env["CLOUDFLARE_LOCATION"];

if (loc !== "loc01") {
  const proc = spawn(
    [
      "/usr/local/bin/tigrisfs",
      "--endpoint",
      "https://s3do.maxm.workers.dev/",
      "-f",
      "foo",
      "/opt/s3",
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        AWS_ACCESS_KEY_ID: "foo",
        AWS_SECRET_ACCESS_KEY: "bar",
      },
    }
  );
}

const server = Bun.serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/____container") {
      fs.writeFileSync("/opt/s3/test.txt", "Hello World!");
      return Response.json(fs.readdirSync("/opt/s3"));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);
