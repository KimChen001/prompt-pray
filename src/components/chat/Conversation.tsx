"use client";
// A free conversation with MOONA. New conversations start on /talk; the address becomes
// /talk/c/<id> after the first message without leaving the page. Replies are appended only to the
// latest copy of the conversation and only if the message they answer is still the newest one, so
// undoing a message, deleting the conversation or clearing data while a reply is on its way never
// brings anything back.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  activeNotes, appendReply, createChat, dataEpoch, deleteChat, getBirth, getChat, getSettings, listChats, listNotes, patchChat, useStoreVersion,
} from "@/lib/store";
import { hasSimilarNote, type MemoryNote } from "@/lib/memory";
import { detectCrisis } from "@/lib/safety";
import { windowMessages } from "@/lib/chat/limits";
import { awaitingReply, newSession, TALK_DRAFT_KEY, type ChatContextChoice, type ChatSession } from "@/lib/chat/session";
import { chartContext, chosenNotes, type TalkBody } from "@/lib/chat/context";
import { localDateKey, userTimeZone, formatLocalDate } from "@/lib/time";
import type { BirthData } from "@/lib/astro/birth";
import type { AiMeta, BasisItem, ChatTurn } from "@/lib/tarot/types";
import { StateOrb, type OrbMode } from "../cosmos/StateOrb";
import { SupportPanel } from "../bits";
import { newRequestId, requestAiOnce } from "@/lib/ai/client";
import { ChatThread, Composer } from "./ChatParts";
import { ContextPanel } from "./ContextPanel";

type Status = "idle" | "sending" | "failed" | "needsAi" | "crisis";

interface TalkResponse {
  reply: string;
  basis: BasisItem[];
  remember: { text: string; quote: string } | null;
  meta: AiMeta;
  code?: string;
}

const DEFAULT_CONTEXT: ChatContextChoice = { chart: false, today: true, noteIds: [] };

export function Conversation({ id }: { id: string | null }) {
  const { m, fmt, locale } = useI18n();
  const router = useRouter();
  const version = useStoreVersion();
  const [sessionId, setSessionId] = useState<string | null>(id);
  const [session, setSession] = useState<ChatSession | null | undefined>(id ? undefined : null);
  const [draftContext, setDraftContext] = useState<ChatContextChoice>(DEFAULT_CONTEXT);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [notice, setNotice] = useState<string | null>(null); // the server's reason when replies are off or failed
  const [orb, setOrb] = useState<OrbMode>("quiet");
  const [birth, setBirth] = useState<BirthData | null>(null);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [freshFrom, setFreshFrom] = useState(Number.POSITIVE_INFINITY);
  const [previous, setPrevious] = useState<ChatSession | undefined>(undefined); // for the greeting; browser-only data
  const inflight = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Load (and follow) the conversation and the things its context depends on.
  useEffect(() => {
    setBirth(getBirth());
    setNotes(listNotes());
    setPrevious(listChats()[0]);
    if (sessionId) {
      const s = getChat(sessionId);
      setSession(s);
      setFreshFrom((f) => (f === Number.POSITIVE_INFINITY && s ? s.turns.length : f));
    }
  }, [sessionId, version]);

  useEffect(() => () => inflight.current?.abort(), []);

  // A draft offered by another page (e.g. Whispers → "Talk about this"): fills the box, sends nothing.
  useEffect(() => {
    if (id) return;
    try {
      const offered = window.sessionStorage.getItem(TALK_DRAFT_KEY);
      if (offered) {
        window.sessionStorage.removeItem(TALK_DRAFT_KEY);
        setDraft(offered);
      }
    } catch {
      /* storage blocked */
    }
  }, [id]);

  const context = session ? session.context : draftContext;
  const turns = useMemo(() => session?.turns ?? [], [session]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, status]);

  const setContext = useCallback((next: ChatContextChoice) => {
    if (sessionId) patchChat(sessionId, (s) => ({ ...s, context: next }));
    else setDraftContext(next);
  }, [sessionId]);

  const request = useCallback(async (s: ChatSession) => {
    const answered = s.turns[s.turns.length - 1];
    const messages = windowMessages(s.turns);
    if (!messages.length || answered.role !== "user") return;
    const ctrl = new AbortController();
    inflight.current?.abort();
    inflight.current = ctrl;
    const epoch = dataEpoch();
    setStatus("sending");
    setOrb("pulse");

    const body: TalkBody = { locale, messages };
    const b = s.context.chart ? getBirth() : null;
    if (b) {
      try {
        body.chart = chartContext(b, getSettings().houseSystem);
      } catch {
        /* chart can't be computed: send without it */
      }
    }
    if (s.context.today) body.today = { date: localDateKey(), timeZone: userTimeZone() };
    const shared = chosenNotes(s.context, activeNotes());
    if (shared.length) body.notes = shared.map((n) => ({ id: n.id, text: n.text }));

    // The id is kept on the message it answers, so "Try again" replays a reply already paid for.
    const remember = (requestId: string) => patchChat(s.id, (latest) => ({ ...latest, turns: latest.turns.map((t) => (t.at === answered.at && t.role === "user" ? { ...t, requestId } : t)) }));
    const requestId = answered.requestId ?? newRequestId();
    if (!answered.requestId) remember(requestId);
    setNotice(null);
    const stop = (next: Status, why: string | null = null) => {
      setOrb("quiet");
      setNotice(why);
      setStatus(next);
    };

    try {
      const out = await requestAiOnce<TalkResponse>("/api/ai/talk", body as unknown as Record<string, unknown>, { requestId, signal: ctrl.signal, onNewId: remember });
      if (ctrl.signal.aborted) return;
      if (out.state === "crisis") return stop("crisis");
      if (out.state === "quota") return stop("needsAi", m.aiNotice.quotaShort);
      if (out.state === "offline") {
        if (out.reason === "busy") return stop("failed", m.aiNotice.busyShort);
        if (out.reason === "network") return stop("failed");
        return stop("needsAi", out.reason === "budget" ? m.aiNotice.budgetShort : out.reason === "ledger" || out.reason === "paused" ? m.aiNotice.pausedShort : null);
      }
      if (out.state !== "done" || !out.value.reply) return stop("failed");
      const data = out.value;
      if (epoch !== dataEpoch()) return; // data was cleared meanwhile
      const suggestion = data.remember && !hasSimilarNote(listNotes(), data.remember.text) ? { ...data.remember, status: "pending" as const } : undefined;
      const reply: ChatTurn = { role: "assistant", content: data.reply, at: new Date().toISOString(), meta: data.meta, basis: data.basis, ...(suggestion ? { suggestion } : {}) };
      const applied = patchChat(s.id, (latest) => {
        const next = appendReply(latest.turns, answered, reply);
        return next ? { ...latest, turns: next, updatedAt: reply.at } : latest;
      });
      setFreshFrom((f) => Math.min(f, applied ? applied.turns.length - 1 : f));
      setStatus("idle");
      setOrb("settle");
    } catch {
      if (ctrl.signal.aborted) return;
      setOrb("quiet");
      setStatus("failed");
    } finally {
      if (inflight.current === ctrl) inflight.current = null;
    }
  }, [locale, m]);

  function send() {
    const text = draft.trim();
    if (!text || status === "sending") return;
    if (detectCrisis(text)) return setStatus("crisis");
    const now = new Date();
    let s: ChatSession | null;
    if (!sessionId) {
      const created = newSession(crypto.randomUUID(), text, draftContext, now);
      createChat(created);
      setSessionId(created.id);
      setSession(created);
      setFreshFrom(1);
      // Keep this page mounted (the request is running); just give it its own address.
      window.history.replaceState(null, "", `/talk/c/${created.id}`);
      s = created;
    } else {
      s = patchChat(sessionId, (latest) => ({ ...latest, turns: [...latest.turns, { role: "user", content: text, at: now.toISOString() }], updatedAt: now.toISOString() }));
      if (!s) return;
      setSession(s);
    }
    setDraft("");
    void request(s);
  }

  /** Withdraw the newest message while MOONA hasn't answered it: cancel the request, keep the text. */
  function undoLast() {
    if (!session) return;
    inflight.current?.abort();
    const last = session.turns[session.turns.length - 1];
    if (!last || last.role !== "user") return;
    if (session.turns.length === 1) {
      deleteChat(session.id);
      setSessionId(null);
      setSession(null);
      window.history.replaceState(null, "", "/talk");
    } else {
      patchChat(session.id, (latest) => ({ ...latest, turns: latest.turns.filter((t) => t.at !== last.at) }));
    }
    setDraft(last.content);
    setStatus("idle");
    setOrb("quiet");
  }

  function remove() {
    if (!session || !window.confirm(m.talk.confirmDelete)) return;
    inflight.current?.abort();
    deleteChat(session.id);
    router.push("/talk");
  }

  const onSuggestion = (turnAt: string, st: "saved" | "dismissed", text: string) => {
    if (!sessionId) return;
    patchChat(sessionId, (latest) => ({
      ...latest,
      turns: latest.turns.map((t): ChatTurn => (t.at === turnAt && t.suggestion ? { ...t, suggestion: { ...t.suggestion, text, status: st } } : t)),
    }));
  };

  if (session === undefined) return null;
  if (sessionId && !session) {
    return (
      <div className="stack gap-4" style={{ maxWidth: 560 }}>
        <h1 className="h1">{m.talk.notFoundTitle}</h1>
        <p className="lede">{m.talk.notFoundBody}</p>
        <div><Link href="/talk" className="btn btn-primary">{m.talk.newChat}</Link></div>
      </div>
    );
  }

  const unanswered = session ? awaitingReply(session) : false;

  return (
    <div className="talk">
      <div className="talk-main">
        <header className="row" style={{ gap: 16, alignItems: "center" }}>
          <StateOrb mode={orb} size="64px" />
          <div className="stack gap-1" style={{ minWidth: 0, flex: 1 }}>
            <p className="eyebrow">{m.talk.eyebrow}</p>
            <h1 className="h2 ellipsis">{session ? session.title : m.talk.title}</h1>
          </div>
          {session && <button type="button" className="btn-text" onClick={remove}>{m.talk.delete}</button>}
        </header>

        <div className="only-mobile">
          <ContextPanel idPrefix="ctx-m" choice={context} onChange={setContext} birth={birth} notes={notes} />
        </div>

        {!session && (
          <div className="chat-turn chat-assistant">
            <span className="chat-who">MOONA</span>
            <p>{previous && previous.id !== sessionId ? fmt(m.talk.welcomeBack, { title: previous.title, date: formatLocalDate(localDateKey(new Date(previous.updatedAt)), locale) }) : m.talk.hello}</p>
            <span className="badge" style={{ alignSelf: "flex-start" }}>{m.talk.fromRecords}</span>
          </div>
        )}

        <ChatThread turns={turns} freshFrom={freshFrom} notes={notes} source={{ chatId: sessionId ?? undefined }} onSuggestion={onSuggestion} />

        {status === "sending" && (
          <div className="row" aria-live="polite">
            <span className="status-line"><span className="status-dot" />{m.talk.thinking}</span>
            <button type="button" className="btn-link" onClick={undoLast}>{m.talk.undo}</button>
          </div>
        )}
        {status === "crisis" && <SupportPanel onEdit={() => setStatus("idle")} />}
        {status === "needsAi" && (
          <p className="notice">{notice ?? m.talk.needsAi}{unanswered && <> <button type="button" className="btn-link" onClick={undoLast}>{m.talk.editLast}</button></>}</p>
        )}
        {(status === "failed" || (status === "idle" && unanswered && session)) && (
          <p className="notice">
            {status === "failed" ? notice ?? m.talk.failed : m.talk.unanswered}{" "}
            <button type="button" className="btn-link" onClick={() => session && void request(session)}>{m.talk.retry}</button>
            {" · "}
            <button type="button" className="btn-link" onClick={undoLast}>{m.talk.editLast}</button>
          </p>
        )}
        {status !== "crisis" && (
          <div className="talk-dock">
            <Composer value={draft} onChange={setDraft} onSend={send} disabled={status === "sending"} placeholder={session ? m.talk.placeholderMore : m.talk.placeholder} label={m.talk.inputLabel} autoFocus />
            <p className="muted small" style={{ margin: "8px 0 0" }}>{m.talk.sendNote}</p>
          </div>
        )}
        {/* after the dock: scrolling here leaves the newest reply (and its note buttons) above the dock, not under it */}
        <div ref={endRef} />
      </div>

      <aside className="talk-side desktop-only">
        <ContextPanel idPrefix="ctx-d" choice={context} onChange={setContext} birth={birth} notes={notes} startOpen />
      </aside>
    </div>
  );
}
