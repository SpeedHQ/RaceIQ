import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "../../components/ChatsPage";

export const Route = createFileRoute("/acc/chats")({
  component: () => (
    <div className="h-full overflow-hidden">
      <ChatsPage />
    </div>
  ),
});
