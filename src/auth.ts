import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import { encryptedPrismaAdapter } from "@/lib/auth-adapter"

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Tokens written through the adapter are AES-256-GCM encrypted at rest.
  adapter: encryptedPrismaAdapter(),
  trustHost: true,
  providers: [
    GitHub({
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && token?.id) {
        session.user.id = token.id as string
      }
      return session
    },
  },
  pages: {
    signIn: "/login",
  },
})
