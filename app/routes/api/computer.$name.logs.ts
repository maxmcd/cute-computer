import type { LoaderFunctionArgs } from "react-router";

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const { name } = params;
  if (!name) {
    return Response.json({ error: "Computer name required" }, { status: 400 });
  }

  const env = context.cloudflare.env;

  // Verify computer exists
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));
  const computer = await computersStub.getComputer(name);

  if (!computer) {
    return Response.json({ error: "Computer not found" }, { status: 404 });
  }

  // Parse query params
  const url = new URL(request.url);
  const before = url.searchParams.get("before") || undefined;
  const search = url.searchParams.get("search") || undefined;
  const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : undefined;

  // Call Logs DO directly via RPC (no auth needed for RPC methods)
  const logsStub = env.LOGS.getByName(name);
  const logs = await logsStub.getLogs({ before, search, limit });

  return Response.json(logs);
}
