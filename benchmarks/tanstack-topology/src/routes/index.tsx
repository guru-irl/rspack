import { createFileRoute } from '@tanstack/react-router';
import { alpha, beta, gamma } from '../functions';
import { Leaf } from '../Leaf';
export const Route = createFileRoute('/')({
  loader: async () => Promise.all([alpha(), beta(), gamma()]),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData();
  return (
    <main>
      <h1>Public topology reproduction</h1>
      <Leaf />
      <pre>{JSON.stringify(data)}</pre>
    </main>
  );
}
