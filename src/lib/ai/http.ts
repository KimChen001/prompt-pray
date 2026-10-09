import "server-only";
import { NextResponse } from "next/server";
import type { AiError } from "./types";

/** Maps AI failures to HTTP; clients keep their offline text for every one of these. */
export function aiErrorResponse(e: AiError) {
  const status =
    e.code === "unconfigured" || e.code === "budget" ? 503 :
    e.code === "timeout" ? 504 :
    502; // upstream, bad_output, refused
  return NextResponse.json({ code: e.code }, { status });
}
