import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Lesson } from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { humanize } from '../words.ts'
import { lessonsQuery, repositoriesQuery } from '../queries.ts'
import { ErrorMessage } from './Shared.tsx'

export function Lessons({
  status,
  repositories = [],
}: {
  status: 'proposed' | 'accepted'
  repositories?: readonly string[]
}) {
  const query = useQuery(lessonsQuery(status))
  const refs = useQuery(repositoriesQuery)
  const visible =
    query.data?.lessons.filter(
      (lesson) =>
        lesson.repositoryId === null ||
        !repositories.length ||
        refs.data?.repositories.some(
          (r) => r.id === lesson.repositoryId && repositories.includes(r.slug),
        ),
    ) ?? []
  if (!visible.length && !query.error) return null
  return (
    <section
      aria-label={status === 'proposed' ? 'Lessons' : 'Accepted lessons'}
    >
      <h2 className="section-title">
        {status === 'proposed' ? 'Lessons' : 'Accepted lessons'}
      </h2>
      <p className="muted">
        {status === 'proposed'
          ? 'Past mistakes suggested from ticket facts. These never hold up work.'
          : 'Agents read these when planning or stuck. Retire a lesson when a check replaces it.'}
      </p>
      <ErrorMessage error={query.error} />
      <ul className="rows lessons-list">
        {visible.map((lesson) => (
          <LessonRow
            key={lesson.id}
            lesson={lesson}
            scope={
              lesson.repositoryId === null
                ? 'Engine'
                : (refs.data?.repositories.find(
                    (r) => r.id === lesson.repositoryId,
                  )?.slug ?? 'Repository')
            }
          />
        ))}
      </ul>
    </section>
  )
}
function LessonRow({ lesson, scope }: { lesson: Lesson; scope: string }) {
  const client = useQueryClient()
  const [retiring, setRetiring] = useState(false)
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: (action: 'accept' | 'reject' | 'retire') =>
      api.decideLesson(lesson.id, action, reason),
    onSuccess: () => client.invalidateQueries({ queryKey: ['lessons'] }),
  })
  return (
    <li className="lesson-row">
      <div className="row-main">
        <span className="muted">
          {scope} · {humanize(lesson.source)}
        </span>
        <p>{lesson.text}</p>
      </div>
      <div className="lesson-actions">
        {lesson.status === 'proposed' ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate('accept')}
            >
              Accept
            </button>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate('reject')}
            >
              Reject
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setRetiring(!retiring)}
            aria-expanded={retiring}
          >
            Retire
          </button>
        )}
      </div>
      {retiring && (
        <form
          className="lesson-retire"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate('retire')
          }}
        >
          <label htmlFor={`retire-${lesson.id}`}>Reason for retiring</label>
          <div className="input-row">
            <input
              id={`retire-${lesson.id}`}
              value={reason}
              maxLength={10000}
              required
              onChange={(event) => setReason(event.target.value)}
              placeholder="Replaced by check X"
            />
            <button disabled={!reason.trim() || mutation.isPending}>
              Retire lesson
            </button>
          </div>
        </form>
      )}
      <ErrorMessage error={mutation.error} />
    </li>
  )
}
