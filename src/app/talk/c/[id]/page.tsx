"use client";
import { useParams } from "next/navigation";
import { useRouteSegment } from "@/lib/shell";
import { Conversation } from "@/components/chat/Conversation";

export default function ConversationPage() {
  const id = useRouteSegment(useParams<{ id: string }>().id, 2); // null until known on the offline shell
  if (id === null) return null;
  return <Conversation key={id} id={id} />;
}
