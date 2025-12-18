import type { LoaderFunctionArgs } from "react-router";

export async function loader({ params, context }: LoaderFunctionArgs) {
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

  // Get the Durable Object ID for the computer's container
  // The ID is deterministic based on the name
  const containerStub = env.APP_CONTAINER.getByName(name);
  const doId = containerStub.id.toString();

  return Response.json({
    computerName: name,
    durableObjectId: doId,
  });
}
