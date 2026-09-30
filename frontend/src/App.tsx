import { AppShell } from "@/components/layout/AppShell";

function App() {
  return (
    <AppShell>
      <div>
        <h1 className="text-3xl font-bold">Welcome to Notify Hub</h1>

        <p className="mt-2 text-muted-foreground">
          Manage and send notifications from one place.
        </p>
      </div>
    </AppShell>
  );
}

export default App;
