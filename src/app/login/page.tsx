import { auth, signIn } from "@/auth"
import { redirect } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Github } from "lucide-react"

export default async function LoginPage() {
  const session = await auth()
  if (session) redirect("/")

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 shadow-sm">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            GitHub Knowledge Hub
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to build your personal R&D knowledge base
          </p>
        </div>

        <form
          action={async () => {
            "use server"
            await signIn("github", { redirectTo: "/" })
          }}
        >
          <Button type="submit" className="w-full" variant="outline">
            <Github className="mr-2 size-4" />
            Continue with GitHub
          </Button>
        </form>
      </div>
    </div>
  )
}
