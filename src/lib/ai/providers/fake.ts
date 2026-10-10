// DEV/REHEARSAL ONLY. An in-process stand-in for a model (AI_PROVIDER=fake): canned, clearly marked
// "[MOCK]" replies in the shapes MOONA validates (the rules of scripts/mock-ai.mjs), simulated usage and
// scripted failures, so budgets, quotas and payments can be rehearsed offline without spending. It is
// not a model: its output is never labelled "Live AI", and config.ts refuses it on deployments unless
// a rehearsal preview opts in (AI_ALLOW_FAKE_ON_DEPLOY=1).
import "server-only";
import type { ModelCaps } from "../capabilities";
import type { AiConfig, EnvLike } from "../config";
import { outputCap } from "../pricing";
import { AiError, type Attempt, type JsonRequest, type NormalizedUsage, type ProviderResult } from "../types";

export interface FakeScript {
  latencyMs?: number;
  fail?: "timeout" | "upstream_5xx" | "rate_limited" | "refusal" | "bad_json" | "max_tokens";
  usage?: "typical" | "max" | "over_bound";
  fallback?: boolean;
}

export const FAKE_MODEL = "simulated";

function reply(req: JsonRequest): Record<string, unknown> {
  const system = req.system;
  const user = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const zh = system.includes("Simplified Chinese");
  const t = (en: string, cn: string) => `[MOCK] ${zh ? cn : en}`;
  const quote = user.slice(0, 40).trim();
  const remember = quote.length >= 4 ? [{ text: t(`Note: ${quote}`, `笔记：${quote}`), quote }] : [];
  switch (req.purpose) {
    case "tarot": {
      const cards = [...user.matchAll(/^Position (\d+) — [^:]+: (.+), (upright|reversed)$/gm)].map(([, pos, name, orient]) => ({
        position: Number(pos),
        insight: orient === "reversed" ? t(`Reversed, ${name} asks you to look again at what feels stuck.`, `${name}逆位，提醒你重新看看卡住的地方。`) : t(`${name} points to something already in motion.`, `${name}指向已经在发生的事。`),
      }));
      return { cards, synthesis: t("Together these cards describe a turning point you are already moving through.", "这几张牌合起来，描述的是你正在经历的一个转折。"), action: t("Write down one thing you want to keep.", "写下一件你想保留的事。"), reflection: t("What would change if you trusted this?", "如果你相信这一点，会有什么不同？") };
    }
    case "chat":
      return { reply: t(`You said: "${user.slice(0, 60)}". The cards stay the same; that detail shifts the emphasis.`, `你说：“${user.slice(0, 40)}”。牌没有变，但这个细节改变了重点。`), remember };
    case "talk": {
      const ids = [...system.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]).slice(0, 2);
      return { reply: t(`I hear: "${user.slice(0, 60)}". One way to look at it: notice what you already know, and what you're guessing.`, `我听到你说：“${user.slice(0, 40)}”。可以先分清哪些是你已经知道的，哪些是猜测。`), basis: ids, remember };
    }
    case "natal": {
      const themes = user.split("\n\n").filter((b) => b.startsWith("Theme ")).map((block) => ({
        id: block.match(/\(id: ([^)]+)\)/)?.[1] ?? "",
        text: t("This theme may show up in how you make everyday choices.", "这个主题可能体现在你日常的选择里。"),
        evidenceIds: [...block.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).slice(0, 2),
      }));
      return { themes, overview: t("Taken together, these themes describe tendencies to notice, not rules.", "合起来看，这些主题描述的是值得留意的倾向，而不是定论。") };
    }
    default:
      return { overall: t("A steady day.", "平稳的一天。"), love: t("Keep it simple.", "简单一点。"), work: t("Finish one thing.", "完成一件事。") };
  }
}

function usageFor(req: JsonRequest, cap: number, s: FakeScript): NormalizedUsage {
  const bytes = Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, schema: req.schema }), "utf8");
  const shape = s.usage ?? "typical";
  const input = shape === "typical" ? Math.min(3800, bytes) : bytes + 2048;
  const output = shape === "typical" ? Math.min(860, cap) : shape === "max" ? cap : cap * 2;
  const attempt = (kind: Attempt["kind"], out: number): Attempt => ({ model: FAKE_MODEL, kind, input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: out });
  const attempts = s.fallback ? [attempt("primary", Math.min(40, output)), attempt("fallback", output)] : [attempt("primary", output)];
  return { attempts, servedModel: FAKE_MODEL, complete: true };
}

export async function callFake(cfg: AiConfig, caps: ModelCaps, req: JsonRequest, script: FakeScript = {}): Promise<ProviderResult> {
  if (script.latencyMs) await new Promise((r) => setTimeout(r, script.latencyMs));
  const cap = outputCap(req, cfg, caps.defaultMaxOutput);
  const usage = usageFor(req, cap, script);
  switch (script.fail) {
    case "timeout":
      throw new AiError("timeout", "simulated timeout", { billing: "unknown" });
    case "upstream_5xx":
      throw new AiError("upstream", "HTTP 503 (simulated)", { billing: "unknown", status: 503 });
    case "rate_limited":
      throw new AiError("upstream", "HTTP 429 (simulated)", { billing: "none", status: 429, rateLimited: true, retryAfterS: 2 });
    case "refusal":
      throw new AiError("refused", "simulated refusal", { usage });
    case "max_tokens":
      throw new AiError("bad_output", "reply was cut off (simulated)", { usage });
    case "bad_json":
      return { text: "[MOCK] not json", model: FAKE_MODEL, usage };
  }
  return { text: JSON.stringify(reply(req)), model: FAKE_MODEL, usage };
}

/** Per-call scripts from FAKE_AI_LATENCY_MS / FAKE_AI_FAILURES ("timeout:0.01,rate_limited:0.02") / FAKE_AI_USAGE, seeded. */
export function fakeScriptFromEnv(env: EnvLike, seed = 1): () => FakeScript {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const kinds = new Set(["timeout", "upstream_5xx", "rate_limited", "refusal", "bad_json", "max_tokens"]);
  const failures = (env.FAKE_AI_FAILURES ?? "").split(",").map((p) => p.trim().split(":")).filter(([k, v]) => kinds.has(k) && Number(v) > 0).map(([k, v]) => [k, Math.min(1, Number(v))] as const);
  const latencyMs = Math.max(0, Number(env.FAKE_AI_LATENCY_MS ?? 0) || 0);
  const usage = (["typical", "max", "over_bound"] as const).find((u) => u === env.FAKE_AI_USAGE) ?? "typical";
  return () => {
    let r = rand();
    for (const [kind, prob] of failures) {
      if (r < prob) return { latencyMs, usage, fail: kind as FakeScript["fail"] };
      r -= prob;
    }
    return { latencyMs, usage };
  };
}
