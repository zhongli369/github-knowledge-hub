import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const publicPaths = ["/login", "/api/auth"]

// NOTE: Do NOT import @/auth here — its PrismaAdapter pulls @prisma/client into
// the Edge Runtime middleware bundle, which Prisma does not support without
// Accelerate or Driver Adapters.  The pages themselves still call auth() for
// full session validation.

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const isPublic = publicPaths.some((p) => pathname.startsWith(p))

  if (isPublic) return NextResponse.next()

  const hasSession = !!(
    req.cookies.get("authjs.session-token") ??
    req.cookies.get("__Secure-authjs.session-token")
  )

  if (!hasSession) {
    const loginUrl = new URL("/login", req.url)
    loginUrl.searchParams.set("callbackUrl", pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (pathname === "/login") {
    return NextResponse.redirect(new URL("/", req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
