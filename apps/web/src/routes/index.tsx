import { Button } from "@folio/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <div className="p-8">
      <h1 className="text-4xl font-bold">Folio</h1>
      <p className="mt-4 text-lg text-muted-foreground">Self-hosted crypto portfolio tracker.</p>
      <Button className="mt-6">Get started</Button>
    </div>
  );
}
