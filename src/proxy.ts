// Gives each browser a signed pseudonymous visitor id on page loads (lib/visitor.ts), so AI limits are
// per person rather than per IP. Static files, images and API routes are skipped; the API reads the
// cookie the page set.
import { NextResponse, type NextRequest } from "next/server";
import { mintVisitor, verifyVisitor, visitorSecret, VISITOR_COOKIE, VISITOR_MAX_AGE } from "@/lib/visitor";

export function proxy(req: NextRequest) {
  const res = NextResponse.next();
  const secret = visitorSecret();
  if (secret && !verifyVisitor(req.cookies.get(VISITOR_COOKIE)?.value, secret)) {
    res.cookies.set({
      name: VISITOR_COOKIE,
      value: mintVisitor(secret),
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: "/",
      maxAge: VISITOR_MAX_AGE,
    });
  }
  return res;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|icons|cards|brand|design|fonts|sw\\.js|manifest\\.webmanifest|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|json|txt|xml|js|css|map|woff2?)$).*)"],
};
