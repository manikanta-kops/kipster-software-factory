import { z } from 'zod'
import {
  HUMAN_CHOICES,
  REPOSITORY_SLUG,
  TICKET_STATUSES,
} from '../domain/records.ts'
import type {
  CancelRequest,
  CreateRepositoryRequest,
  CreateTicketRequest,
  DecisionRequest,
  ResolveRequest,
} from './contract.ts'

const text = z.string().trim()
const attemptId = z.int().positive()

export const createRepositoryRequest = z.strictObject({
  slug: text.regex(REPOSITORY_SLUG, 'use owner/name'),
  cloneUrl: text.min(1).optional(),
  defaultBranch: text.min(1).optional(),
}) satisfies z.ZodType<CreateRepositoryRequest>

export const createTicketRequest = z.strictObject({
  repository: text.min(1),
  workflow: text.min(1),
  title: text.min(1).max(200),
  body: z.string().max(100_000).optional(),
}) satisfies z.ZodType<CreateTicketRequest>

export const decisionRequest = z.strictObject({
  attemptId,
  choice: z.enum(HUMAN_CHOICES),
  comment: z.string().max(100_000).optional(),
}) satisfies z.ZodType<DecisionRequest>

const note = z.string().max(100_000).optional()

export const resolveRequest = z.discriminatedUnion('action', [
  z.strictObject({ attemptId, note, action: z.literal('retry') }),
  z.strictObject({
    attemptId,
    note,
    action: z.literal('move'),
    stepId: text.min(1),
  }),
  z.strictObject({ attemptId, note, action: z.literal('cancel') }),
]) satisfies z.ZodType<ResolveRequest>

export const cancelRequest = z.strictObject({
  reason: z.string().max(100_000).optional(),
}) satisfies z.ZodType<CancelRequest>

/** `?status=needs-you,queued` */
export const statusFilter = z
  .string()
  .transform((value) => value.split(',').filter((part) => part !== ''))
  .pipe(z.array(z.enum(TICKET_STATUSES)).min(1))

export const optionRequest = z.strictObject({
  attemptId,
  option: z.string().min(1).max(200),
})
