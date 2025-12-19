import type { LoaderFunctionArgs } from "react-router";
import { signToken } from "../../../worker/lib/jwt";

export async function loader({ params, context }: LoaderFunctionArgs) {
  const { name } = params;

  if (!name) {
    return Response.json({ error: "Computer name required" }, { status: 400 });
  }

  const env = context.cloudflare.env;

  // Verify computer exists and get secrets
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));
  const computer = await computersStub.getComputer(name);

  if (!computer) {
    return Response.json({ error: "Computer not found" }, { status: 404 });
  }

  // Get the Durable Object ID for the computer's container
  // The ID is deterministic based on the name
  const containerStub = env.APP_CONTAINER.getByName(name);
  const doId = containerStub.id.toString();
  const bucket = `s3-${doId}`;

  // Parse secrets from JSON
  const secrets: string[] = JSON.parse(computer.secrets);
  if (secrets.length === 0) {
    return Response.json({ error: "No secrets configured" }, { status: 500 });
  }

  // Generate JWT token (1 hour expiry for frontend)
  const token = await signToken(
    {
      sub: name,
      bucket: bucket,
      expiresIn: 3600, // 1 hour
    },
    secrets[0] // Use first secret
  );

  return Response.json({
    computerName: name, // This is the slug
    computerDisplayName: computer.name, // The actual display name
    durableObjectId: doId,
    token: token,
    expiresIn: 3600,
  });
}
