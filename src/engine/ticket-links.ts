import { FactoryError } from '../domain/errors.ts'
import type { StepResult } from '../domain/lifecycle.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from '../library/library.ts'
import {
  addAttemptArtifacts,
  failAttempt,
  recordAttemptHeadCommit,
  linkOtherRepository,
  resolveLinkedTicket,
} from '../store/tickets.ts'
import { listTicketLinks } from '../store/ticket-links.ts'
import type { RunnerOptions } from './runner.ts'

export async function requestOtherRepository(
  options: RunnerOptions,
  attemptId: number,
  result: StepResult,
  headCommit: string,
): Promise<void> {
  try {
    let library = options.library
    if (!library) {
      const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
      if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
      library = loaded.library
    }
    const entry = library.get(result.otherRepository!.workflow)
    if (!entry)
      throw new FactoryError(
        'invalid',
        `No workflow "${result.otherRepository!.workflow}" for the linked ticket`,
      )
    await linkOtherRepository(
      options.database,
      attemptId,
      result,
      entry,
      headCommit,
    )
  } catch (error) {
    if (!(error instanceof FactoryError) || error.code === 'not-found')
      throw error
    await addAttemptArtifacts(options.database, attemptId, [
      ...result.artifacts,
      {
        kind: 'finding',
        title: 'Other repository request needs you',
        content: `${error.message}\n\nRequested change:\n${JSON.stringify(result.otherRepository, null, 2)}`,
      },
    ])
    await recordAttemptHeadCommit(options.database, attemptId, headCommit)
    await failAttempt(
      options.database,
      attemptId,
      `Cannot open linked ticket: ${error.message}`,
    )
  }
}

export async function pollLinkedTickets(
  options: RunnerOptions,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) => {
    throw error
  },
): Promise<void> {
  for (const link of await listTicketLinks(options.database)) {
    signal.throwIfAborted()
    try {
      const ticket = link.linked
      if (ticket.status === 'cancelled') {
        await resolveLinkedTicket(
          options.database,
          link,
          null,
          `Linked ticket #${ticket.number} (${ticket.repository.slug}) was cancelled. Decide whether to retry this builder, move it, or cancel this ticket.`,
        )
        continue
      }
      if (!ticket.pullRequestUrl) {
        await resolveLinkedTicket(
          options.database,
          link,
          null,
          `Linked ticket #${ticket.number} finished without a merged pull request. The owner must decide how to continue.`,
        )
        continue
      }
      const pr = await options.github.inspect(
        ticket.repository.slug,
        ticket.pullRequestUrl,
        signal,
      )
      if (
        pr.state !== 'MERGED' ||
        !pr.mergeCommit?.oid ||
        !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(pr.mergeCommit.oid)
      ) {
        await resolveLinkedTicket(
          options.database,
          link,
          null,
          `Linked ticket #${ticket.number} finished, but its PR merge commit could not be confirmed: ${ticket.pullRequestUrl}. The owner must decide how to continue.`,
        )
        continue
      }
      await resolveLinkedTicket(
        options.database,
        link,
        pr.mergeCommit.oid,
        `Linked ticket #${ticket.number} (${ticket.repository.slug}) merged: ${ticket.pullRequestUrl}\nMerge commit: ${pr.mergeCommit.oid}\nResume the builder using this change.`,
      )
    } catch (error) {
      signal.throwIfAborted()
      onError(error)
    }
  }
}
