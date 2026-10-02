import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "../../components/ChatsPage";

export const Route = createFileRoute("/$gameid/chats")({
  component: ChatsPage,
});
