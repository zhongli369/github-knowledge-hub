"use client"

import { useState, useCallback, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Pencil, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { updateRepoMeta } from "@/actions/repos"

interface RepoNoteEditorProps {
  repoId: string
  initialNote: string
}

export function RepoNoteEditor({ repoId, initialNote }: RepoNoteEditorProps) {
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(initialNote)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const save = useCallback(() => {
    startTransition(async () => {
      await updateRepoMeta(repoId, { note })
      setEditing(false)
      router.refresh()
    })
  }, [repoId, note, router])

  const cancel = useCallback(() => {
    setNote(initialNote)
    setEditing(false)
  }, [initialNote])

  if (!editing) {
    return (
      <div className="flex items-start gap-2">
        {initialNote ? (
          <p className="flex-1 text-sm text-muted-foreground">{initialNote}</p>
        ) : (
          <p className="flex-1 text-sm text-muted-foreground/50 italic">
            No notes yet…
          </p>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3" />
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add your notes about this repo…"
        className="min-h-[60px] text-sm"
        rows={2}
      />
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={save}
          disabled={isPending}
        >
          <Check className="mr-1 size-3" />
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel}>
          <X className="mr-1 size-3" />
          Cancel
        </Button>
      </div>
    </div>
  )
}
