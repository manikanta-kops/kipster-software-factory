import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentChoice,
  Settings,
  SettingsResponse,
} from '../../../src/api/contract.ts'
import {
  settingsProblems,
  settingsSchema,
} from '../../../src/domain/settings.ts'
import { api, ApiError } from '../api.ts'
import { ErrorMessage } from '../components/Shared.tsx'
import { settingsQuery } from '../queries.ts'

type Choices = SettingsResponse['choices']
type Role = Choices['roles'][number]

interface AgentDraft {
  cli: string
  model: string
  effort: string
}
interface OverrideDraft {
  workflow: string
  timeout: string
  roles: Partial<Record<Role, AgentDraft>>
}
interface Draft {
  concurrency: string
  timeout: string
  default: AgentDraft
  roles: Partial<Record<Role, AgentDraft>>
  allowed: AgentDraft[]
  overrides: OverrideDraft[]
}

const EMPTY_AGENT: AgentDraft = { cli: '', model: '', effort: '' }

function agentDraft(agent: AgentChoice | undefined): AgentDraft {
  return agent
    ? { cli: agent.cli, model: agent.model ?? '', effort: agent.effort ?? '' }
    : EMPTY_AGENT
}
function roleDrafts(choices: Settings['agents']['roles']) {
  return Object.fromEntries(
    Object.entries(choices).map(([role, choice]) => [role, agentDraft(choice)]),
  ) as Partial<Record<Role, AgentDraft>>
}
function toDraft(settings: Settings): Draft {
  return {
    concurrency: String(settings.concurrency),
    timeout: String(settings.stepTimeoutMinutes),
    default: agentDraft(settings.agents.default),
    roles: roleDrafts(settings.agents.roles),
    allowed: settings.agents.allowed.map(agentDraft),
    overrides: Object.entries(settings.workflows).map(
      ([workflow, override]) => ({
        workflow,
        timeout:
          override.stepTimeoutMinutes === undefined
            ? ''
            : String(override.stepTimeoutMinutes),
        roles: roleDrafts(override.roles ?? {}),
      }),
    ),
  }
}

/** Empty strings stay as they are, so the schema reports them rather than guessing. */
function number(value: string): unknown {
  return value.trim() === '' ? value : Number(value)
}
function agentInput(draft: AgentDraft): unknown {
  return {
    cli: draft.cli,
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
  }
}
function roleInputs(drafts: Partial<Record<Role, AgentDraft>>) {
  return Object.fromEntries(
    Object.entries(drafts)
      .filter(([, draft]) => draft.cli !== '')
      .map(([role, draft]) => [role, agentInput(draft)]),
  )
}
function fromDraft(draft: Draft): unknown {
  return {
    concurrency: number(draft.concurrency),
    stepTimeoutMinutes: number(draft.timeout),
    agents: {
      default: agentInput(draft.default),
      roles: roleInputs(draft.roles),
      allowed: draft.allowed.map(agentInput),
    },
    workflows: Object.fromEntries(
      draft.overrides.map((override) => [
        override.workflow,
        {
          ...(override.timeout.trim() === ''
            ? {}
            : { stepTimeoutMinutes: number(override.timeout) }),
          roles: roleInputs(override.roles),
        },
      ]),
    ),
  }
}

type Issues = ReadonlyMap<string, string>

function validate(
  draft: Draft,
  workflows: readonly string[],
): { settings: Settings } | { issues: Issues } {
  const parsed = settingsSchema.safeParse(fromDraft(draft))
  if (!parsed.success)
    return {
      issues: new Map(
        parsed.error.issues.map((issue) => [
          issue.path.join('.'),
          issue.message,
        ]),
      ),
    }
  const problems = settingsProblems(parsed.data, workflows)
  if (problems.length)
    return {
      issues: new Map(
        problems.map((problem) => {
          const [path, message] = problem.split(': ')
          return [path!, message!]
        }),
      ),
    }
  return { settings: parsed.data }
}

/** Server issues read `path: message`. */
function serverIssues(error: Error | null): Issues {
  if (!(error instanceof ApiError)) return new Map()
  return new Map(
    error.issues.map((issue) => {
      const at = issue.indexOf(': ')
      return at < 0 ? ['', issue] : [issue.slice(0, at), issue.slice(at + 2)]
    }),
  )
}
function issueAt(issues: Issues, prefix: string): string | undefined {
  for (const [path, message] of issues)
    if (path === prefix || path.startsWith(`${prefix}.`)) return message
  return undefined
}

export function SettingsPage() {
  const query = useQuery(settingsQuery)
  return (
    <section className="settings-page">
      <header className="page-heading">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            How many steps run at once, how long a step may take and which agent
            runs each role. Steps that start after you save use the new values;
            running steps keep theirs.
          </p>
        </div>
      </header>
      <ErrorMessage error={query.error} />
      {query.isPending && <p className="muted">Loading settings…</p>}
      {query.data && <SettingsForm response={query.data} />}
    </section>
  )
}

function SettingsForm({ response }: { response: SettingsResponse }) {
  const client = useQueryClient()
  const [draft, setDraft] = useState(() => toDraft(response.settings))
  const [local, setLocal] = useState<Issues>(new Map())
  const [adding, setAdding] = useState('')
  const save = useMutation({
    mutationFn: (settings: Settings) => api.saveSettings(settings),
    onSuccess: (data) => client.setQueryData(['settings'], data),
  })
  const issues = local.size ? local : serverIssues(save.error)
  const { choices, workflows } = response
  const update = (change: (draft: Draft) => Draft) => {
    setDraft(change)
    setLocal(new Map())
    save.reset()
  }
  const unused = workflows.filter(
    (name) => !draft.overrides.some((override) => override.workflow === name),
  )
  return (
    <form
      className="settings-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const checked = validate(draft, workflows)
        if ('issues' in checked) setLocal(checked.issues)
        else save.mutate(checked.settings)
      }}
    >
      <output className="settings-source">
        {response.source === 'saved' && response.updatedAt
          ? `Saved ${new Date(response.updatedAt).toLocaleString()}. config.json values for these settings are ignored.`
          : 'From config.json. Saving stores these in the factory database.'}
      </output>

      <fieldset>
        <legend>Limits</legend>
        <div className="settings-grid">
          <NumberField
            id="settings-concurrency"
            label="Steps running at once"
            value={draft.concurrency}
            issue={issueAt(issues, 'concurrency')}
            onChange={(value) => update((d) => ({ ...d, concurrency: value }))}
          />
          <NumberField
            id="settings-timeout"
            label="Step timeout (minutes)"
            value={draft.timeout}
            issue={issueAt(issues, 'stepTimeoutMinutes')}
            onChange={(value) => update((d) => ({ ...d, timeout: value }))}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Agents</legend>
        <AgentFields
          label="Default"
          value={draft.default}
          choices={choices}
          issue={issueAt(issues, 'agents.default')}
          onChange={(value) => update((d) => ({ ...d, default: value }))}
        />
        {choices.roles.map((role) => (
          <AgentFields
            key={role}
            label={role}
            optional
            value={draft.roles[role] ?? EMPTY_AGENT}
            choices={choices}
            issue={issueAt(issues, `agents.roles.${role}`)}
            onChange={(value) =>
              update((d) => ({ ...d, roles: { ...d.roles, [role]: value } }))
            }
          />
        ))}
      </fieldset>

      <fieldset>
        <legend>Agents a lead may choose for a task</legend>
        <p className="muted">
          A task&apos;s agent runs only its builder; testers and reviewers keep
          their own settings.
        </p>
        {draft.allowed.map((item, index) => (
          <div className="settings-row" key={index}>
            <AgentFields
              label={`Allowed ${index + 1}`}
              value={item}
              choices={choices}
              issue={issueAt(issues, `agents.allowed.${index}`)}
              onChange={(value) =>
                update((d) => ({
                  ...d,
                  allowed: d.allowed.map((old, at) =>
                    at === index ? value : old,
                  ),
                }))
              }
            />
            <button
              type="button"
              className="button"
              aria-label={`Remove allowed agent ${index + 1}`}
              onClick={() =>
                update((d) => ({
                  ...d,
                  allowed: d.allowed.filter((_, at) => at !== index),
                }))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button"
          onClick={() =>
            update((d) => ({
              ...d,
              allowed: [...d.allowed, { ...EMPTY_AGENT, cli: 'claude' }],
            }))
          }
        >
          Add allowed agent
        </button>
      </fieldset>

      <fieldset>
        <legend>Workflow overrides</legend>
        <p className="muted">
          Agents and a step timeout for one workflow. Empty fields use the
          values above.
        </p>
        {draft.overrides.map((override, index) => {
          const change = (next: Partial<OverrideDraft>) =>
            update((d) => ({
              ...d,
              overrides: d.overrides.map((old, at) =>
                at === index ? { ...old, ...next } : old,
              ),
            }))
          const at = `workflows.${override.workflow}`
          return (
            <section
              className="settings-override"
              key={override.workflow}
              aria-label={`Override for ${override.workflow}`}
            >
              <div className="settings-row">
                <h3>{override.workflow}</h3>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      overrides: d.overrides.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Remove override
                </button>
              </div>
              {!workflows.includes(override.workflow) && (
                <p className="error">Unknown workflow. Remove this override.</p>
              )}
              {issueAt(issues, at) &&
                !issueAt(issues, `${at}.stepTimeoutMinutes`) &&
                !issueAt(issues, `${at}.roles`) && (
                  <p className="error">{issueAt(issues, at)}</p>
                )}
              <NumberField
                id={`override-${override.workflow}-timeout`}
                label={`Step timeout for ${override.workflow} (minutes)`}
                value={override.timeout}
                issue={issueAt(issues, `${at}.stepTimeoutMinutes`)}
                onChange={(value) => change({ timeout: value })}
              />
              {choices.roles.map((role) => (
                <AgentFields
                  key={role}
                  label={`${override.workflow} ${role}`}
                  optional
                  value={override.roles[role] ?? EMPTY_AGENT}
                  choices={choices}
                  issue={issueAt(issues, `${at}.roles.${role}`)}
                  onChange={(value) =>
                    change({ roles: { ...override.roles, [role]: value } })
                  }
                />
              ))}
            </section>
          )
        })}
        <div className="input-row">
          <select
            aria-label="Workflow to override"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
          >
            <option value="">Choose a workflow</option>
            {unused.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            disabled={!adding}
            onClick={() => {
              update((d) => ({
                ...d,
                overrides: [
                  ...d.overrides,
                  { workflow: adding, timeout: '', roles: {} },
                ],
              }))
              setAdding('')
            }}
          >
            Add override
          </button>
        </div>
      </fieldset>

      {issues.get('') && <p className="error">{issues.get('')}</p>}
      {local.size > 0 && (
        <p className="error" role="alert">
          Fix the highlighted fields before saving.
        </p>
      )}
      {save.error && <ErrorMessage error={save.error} />}
      <div className="actions">
        <button className="button primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </button>
        {save.isSuccess && <output>Settings saved.</output>}
      </div>
    </form>
  )
}

function NumberField({
  id,
  label,
  value,
  issue,
  onChange,
}: {
  id: string
  label: string
  value: string
  issue: string | undefined
  onChange: (value: string) => void
}) {
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={value}
        aria-invalid={issue ? true : undefined}
        aria-describedby={issue ? `${id}-issue` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {issue && (
        <p className="error" id={`${id}-issue`}>
          {issue}
        </p>
      )}
    </div>
  )
}

function AgentFields({
  label,
  value,
  choices,
  optional = false,
  issue,
  onChange,
}: {
  label: string
  value: AgentDraft
  choices: Choices
  optional?: boolean
  issue: string | undefined
  onChange: (value: AgentDraft) => void
}) {
  const unset = optional && value.cli === ''
  return (
    <fieldset className="agent-fields" aria-label={`${label} agent`}>
      <span className="agent-label">{label}</span>
      <select
        aria-label={`${label} CLI`}
        value={value.cli}
        onChange={(event) => onChange({ ...value, cli: event.target.value })}
      >
        {optional && <option value="">Use default</option>}
        {choices.clis.map((cli) => (
          <option key={cli} value={cli}>
            {cli}
          </option>
        ))}
      </select>
      <input
        aria-label={`${label} model`}
        placeholder="CLI default model"
        disabled={unset}
        value={value.model}
        onChange={(event) => onChange({ ...value, model: event.target.value })}
      />
      <select
        aria-label={`${label} effort`}
        disabled={unset}
        value={value.effort}
        onChange={(event) => onChange({ ...value, effort: event.target.value })}
      >
        <option value="">CLI default effort</option>
        {choices.efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
      {issue && <p className="error">{issue}</p>}
    </fieldset>
  )
}
