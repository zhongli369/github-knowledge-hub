"use client"

import { useCallback, useTransition } from "react"
import { useRouter } from "next/navigation"
import { updateRepoMeta } from "@/actions/repos"

const STATUSES = [
  { value: "new", label: "New" },
  { value: "analyzing", label: "Analyzing" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

const STATUS_STYLES: Record<string, string> = {
  new: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  analyzing: "border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  active: "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
  archived: "border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400",
}

interface RepoStatusSelectProps {
  repoId: string
  currentStatus: string
}

export function RepoStatusSelect({
  repoId,
  currentStatus,
}: RepoStatusSelectProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const handleChange = useCallback(
    (status: string) => {
      startTransition(async () => {
        await updateRepoMeta(repoId, { status })
        router.refresh()
      })
    },
    [repoId, router]
  )

  return (
    <select
      value={currentStatus}
      onChange={(e) => handleChange(e.target.value)}
      disabled={isPending}
      className={`rounded-md border px-2 py-1 text-xs font-medium cursor-pointer ${
        STATUS_STYLES[currentStatus] ?? ""
      }`}
    >
      {STATUSES.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  )
}
