import { PetOverlay } from "./components/PetOverlay";
import { SetupFlow } from "./components/SetupFlow";
import { ChatWidget } from "./components/ChatWidget";

export function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "pet") return <PetOverlay />;
  if (view === "chat") return <ChatWidget />;
  return <SetupFlow />;
}
