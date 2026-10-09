// DEV ONLY. A fake OpenAI-compatible endpoint that returns canned, clearly marked "[MOCK]" text in
// the shapes MOONA expects, so the UI's AI paths can be exercised without a key or spending credit.
// It is not a model: never point a public deployment at it, and never cite its output as AI quality.
// Usage: node scripts/mock-ai.mjs [port]   then run the app with
//   AI_API_KEY=mock AI_BASE_URL=http://127.0.0.1:<port>/v1 AI_MODEL=mock-model
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3999);

function reply(body) {
  const system = body.messages?.[0]?.content ?? "";
  const user = body.messages?.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const zh = system.includes("Simplified Chinese");
  const t = (en, cn) => `[MOCK] ${zh ? cn : en}`;

  if (system.includes("tarot reader")) {
    const cards = [...user.matchAll(/^Position (\d+) — [^:]+: (.+), (upright|reversed)$/gm)].map(([, pos, name, orient]) => ({
      position: Number(pos),
      insight: orient === "reversed" ? t(`Reversed, ${name} asks you to look again at what feels stuck.`, `${name}逆位，提醒你重新看看卡住的地方。`) : t(`${name} points to something already in motion.`, `${name}指向已经在发生的事。`),
    }));
    return { cards, synthesis: t("Together these cards describe a turning point you are already moving through.", "这几张牌合起来，描述的是你正在经历的一个转折。"), action: t("Write down one thing you want to keep.", "写下一件你想保留的事。"), reflection: t("What would change if you trusted this?", "如果你相信这一点，会有什么不同？") };
  }
  if (system.includes("continuing a conversation")) {
    // Offers to remember the start of the person's message (a real substring, as the server requires).
    const quote = user.slice(0, 40).trim();
    return {
      reply: t(`You said: "${user.slice(0, 60)}". The cards stay the same; that detail shifts the emphasis.`, `你说：“${user.slice(0, 40)}”。牌没有变，但这个细节改变了重点。`),
      remember: quote.length >= 4 ? [{ text: t(`Note: ${quote}`, `笔记：${quote}`), quote }] : [],
    };
  }
  if (system.includes("companion for reflection")) {
    // Talk: cites up to two context ids it was given (a real subset, as the server requires).
    const ids = [...system.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]).slice(0, 2);
    const quote = user.slice(0, 40).trim();
    return {
      reply: t(`I hear: "${user.slice(0, 60)}". One way to look at it: notice what you already know, and what you're guessing.`, `我听到你说：“${user.slice(0, 40)}”。可以先分清哪些是你已经知道的，哪些是猜测。`),
      basis: ids,
      remember: quote.length >= 4 ? [{ text: t(`Note: ${quote}`, `笔记：${quote}`), quote }] : [],
    };
  }
  if (system.includes("birth-chart reading")) {
    const themes = user.split("\n\n").filter((b) => b.startsWith("Theme ")).map((block) => ({
      id: block.match(/\(id: ([^)]+)\)/)[1],
      text: t("This theme may show up in how you make everyday choices.", "这个主题可能体现在你日常的选择里。"),
      evidenceIds: [...block.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).slice(0, 2),
    }));
    return { themes, overview: t("Taken together, these themes describe tendencies to notice, not rules.", "合起来看，这些主题描述的是值得留意的倾向，而不是定论。") };
  }
  if (system.includes("astrology companion")) {
    return { overall: t("A steady day.", "平稳的一天。"), love: t("Keep it simple.", "简单一点。"), work: t("Finish one thing.", "完成一件事。") };
  }
  return { error: "unknown purpose" };
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw || "{}");
    const content = JSON.stringify(reply(body));
    // MOCK_DELAY_MS simulates a slow model (to test undo, delete and language switches mid-request).
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "mock-model", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 200 } }));
    }, Number(process.env.MOCK_DELAY_MS ?? 0));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock AI listening on http://127.0.0.1:${port}/v1 (DEV ONLY)`));
