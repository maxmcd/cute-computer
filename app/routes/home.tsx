import { Form, useNavigation, redirect, Link } from "react-router";

export function meta() {
  return [{ title: "Cute Computer" }, { name: "description", content: "" }];
}

export async function loader({ context }: any) {
  const { env } = context.cloudflare;

  // Get the Computers DO instance
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));

  // Fetch list of computers
  const computers = await computersStub.listComputers();

  return { computers };
}

export async function action({ context }: any) {
  const { env } = context.cloudflare;

  // Get the Computers DO instance
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));

  // Call the RPC method to create the computer (name generated server-side)
  const result = await computersStub.createComputer();

  if (!result.success) {
    return { error: result.error, computerName: null };
  }

  // Redirect to the computer page
  return redirect(`/computer/${result.computer?.name}`);
}

export default function Home({ actionData, loaderData }: any) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { computers } = loaderData;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-300 p-8">
      <div className="text-center text-purple-900 max-w-2xl w-full">
        <h1 className="text-5xl font-bold mb-8 drop-shadow-sm">
          Cute Computer
        </h1>
        {actionData?.error && (
          <div className="mb-6 p-4 bg-red-100 text-red-700 rounded-lg">
            Error: {actionData.error}
          </div>
        )}

        <Form method="post" className="mb-12">
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-block px-8 py-4 bg-white text-purple-600 hover:bg-purple-50 hover:text-purple-700 rounded-lg text-lg font-medium transition-colors duration-200 shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Creating..." : "Create Computer"}
          </button>
        </Form>

        {computers.length > 0 && (
          <div className="bg-white/80 backdrop-blur rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-bold mb-4 text-purple-900">
              Computers
            </h2>
            <div className="space-y-2">
              {computers.map((computer: any) => (
                <Link
                  key={computer.id}
                  to={`/computer/${computer.name}`}
                  className="block p-4 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors duration-200 text-left"
                >
                  <div className="flex justify-between items-center">
                    <span className="font-medium text-purple-900">
                      {computer.name}
                    </span>
                    <span className="text-sm text-purple-600">
                      {new Date(computer.created_at).toLocaleDateString()}{" "}
                      {new Date(computer.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
