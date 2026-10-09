"use client";
// Talk with MOONA: start a new conversation (context chosen by the person), or reopen one.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { deleteChat, listChats, useStoreVersion } from "@/lib/store";
import type { ChatSession } from "@/lib/chat/session";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { Conversation } from "@/components/chat/Conversation";

export default function TalkPage() {
  const { m, fmt, locale } = useI18n();
  const version = useStoreVersion();
  const [chats, setChats] = useState<ChatSession[]>([]);
  useEffect(() => setChats(listChats()), [version]);

  return (
    <div className="stack gap-12">
      <Conversation id={null} />
      {chats.length > 0 && (
        <section className="stack gap-3" aria-labelledby="chats-title" style={{ maxWidth: 760 }}>
          <h2 className="h3" id="chats-title">{m.talk.yourChats}</h2>
          <ul className="session-list">
            {chats.map((c) => (
              <li key={c.id}>
                <Link href={`/talk/c/${c.id}`}>
                  <span className="ellipsis" style={{ color: "var(--text-1)" }}>{c.title}</span>
                  <span className="muted small">{formatLocalDate(localDateKey(new Date(c.updatedAt)), locale)} · {c.turns.length === 1 ? m.talk.messagesOne : fmt(m.talk.messages, { n: c.turns.length })}</span>
                </Link>
                <button type="button" className="btn-text" onClick={() => window.confirm(m.talk.confirmDelete) && deleteChat(c.id)}>{m.talk.delete}</button>
              </li>
            ))}
          </ul>
          <p className="muted small" style={{ margin: 0 }}>{m.talk.deviceOnly}</p>
        </section>
      )}
    </div>
  );
}
