import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

// This route proxies file API requests to the container
// Handles: /api/computer/:name/files/*

async function proxyToContainer(
  request: Request,
  computerName: string,
  env: Env,
  splat: string
): Promise<Response> {
  // Verify computer exists
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));
  const computer = await computersStub.getComputer(computerName);

  if (!computer) {
    return Response.json({ error: "Computer not found" }, { status: 404 });
  }

  // Rewrite URL to container's /api/files endpoint
  const url = new URL(request.url);
  const containerPath = splat ? `/api/files/${splat}` : `/api/files`;
  url.pathname = containerPath;

  // Create new request with rewritten URL
  const containerRequest = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  // Forward request to container
  const containerStub = env.APP_CONTAINER.getByName(computerName);
  return containerStub.fetch(containerRequest);
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const { name, "*": splat } = params;
  if (!name) {
    return Response.json({ error: "Computer name required" }, { status: 400 });
  }

  const env = context.cloudflare.env;
  return proxyToContainer(request, name, env, splat || "");
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { name, "*": splat } = params;
  if (!name) {
    return Response.json({ error: "Computer name required" }, { status: 400 });
  }

  const env = context.cloudflare.env;
  return proxyToContainer(request, name, env, splat || "");
}
