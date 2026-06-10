import { Dashboard, type DashboardData } from "./quasar-dashboard";

export const dynamic = "force-dynamic";

const emptyDashboard: DashboardData = {
  projects: [],
  sessions: [],
  searchDiagnostics: {
    embeddingsConfigured: false,
  },
};

export default async function Page() {
  return <Dashboard initial={emptyDashboard} />;
}
