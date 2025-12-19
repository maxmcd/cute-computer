import { Form, useNavigation, redirect, Link } from "react-router";

export function meta() {
  return [
    { title: ">_< - Cute Computer" },
    { name: "description", content: "" },
  ];
}

export async function loader({ context }: any) {
  const { env } = context.cloudflare;

  // Get the Computers DO instance
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));

  // Fetch list of computers
  const computers = await computersStub.listComputers();

  return { computers };
}

export async function action({ request, context }: any) {
  const { env } = context.cloudflare;

  // Get form data
  const formData = await request.formData();
  const name = formData.get("name") as string;

  // Validate name is provided
  if (!name || !name.trim()) {
    return { error: "Computer name is required" };
  }

  // Get the Computers DO instance
  const computersStub = env.COMPUTERS.get(env.COMPUTERS.idFromName("global"));

  // Call the RPC method to create the computer with name
  const result = await computersStub.createComputer(name);

  if (!result.success) {
    return { error: result.error };
  }

  // Redirect to the computer page using slug
  return redirect(`/computer/${result.computer?.slug}`);
}

export default function Home({ actionData, loaderData }: any) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { computers } = loaderData;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-300 p-8">
      <div className="text-center text-purple-900 max-w-2xl w-full font-mono">
        <h1 className="text-5xl font-bold mb-8">{">_< "}Cute Computer</h1>
        {actionData?.error && (
          <div className="mb-6 p-4 bg-red-100 text-red-700 rounded-lg">
            Error: {actionData.error}
          </div>
        )}

        <Form method="post" className="mb-12">
          <div className="flex flex-col sm:flex-row gap-4 max-w-lg mx-auto">
            <input
              type="text"
              name="name"
              placeholder="Enter computer name"
              required
              className="flex-1 px-4 py-3 rounded-lg border-2 border-purple-400 focus:border-purple-600 focus:outline-none text-purple-900 placeholder-purple-400"
              disabled={isSubmitting}
            />
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-8 py-3 bg-white text-purple-600 hover:bg-purple-50 hover:text-purple-700 rounded-lg text-lg font-medium transition-colors duration-200 shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isSubmitting ? "Creating..." : "Create"}
            </button>
          </div>
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
                  to={`/computer/${computer.slug}`}
                  className="block p-4 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors duration-200 text-left"
                >
                  <div className="flex justify-between items-center">
                    <span className="font-medium text-purple-900">
                      {computer.name}
                    </span>
                    <span className="text-sm text-purple-600">
                      {new Date(computer.created_at).toLocaleDateString()}
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
