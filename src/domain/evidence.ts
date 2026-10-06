import type { Artifact, Attempt } from './records.ts'
export interface ScenarioEvidence {
  scenario: string
  role: 'tester' | 'reproducer'
  result: string
  commit: string | null
  artifactId: number
  current: boolean
}
/** One key item per scenario and independent role; newest attempt, then prefer visual proof. */
export function scenarioIndex(
  artifacts: readonly Artifact[],
  attempts: readonly Attempt[],
  roles: ReadonlyMap<string, string>,
  head: string | null,
): ScenarioEvidence[] {
  const groups = new Map<string, Artifact[]>()
  for (const artifact of artifacts) {
    const role = roles.get(artifact.stepId)
    if (
      artifact.kind !== 'evidence' ||
      !artifact.scenario ||
      !['tester', 'reproducer'].includes(role ?? '')
    )
      continue
    const key = `${role}:${artifact.scenario}`
    groups.set(key, [...(groups.get(key) ?? []), artifact])
  }
  const rank = (a: Artifact) =>
    a.mediaType.startsWith('image/')
      ? 2
      : a.mediaType.startsWith('video/')
        ? 1
        : 0
  return [...groups.values()].map((items) => {
    const newest = Math.max(...items.map((a) => a.attemptId))
    const candidates = items.filter((a) => a.attemptId === newest)
    const target = candidates.some((a) => a.observedCommit === head)
      ? candidates.filter((a) => a.observedCommit === head)
      : candidates
    const artifact = target
      .filter((a) => a.attemptId === newest)
      .sort((a, b) => rank(b) - rank(a) || b.id - a.id)[0]!
    const attempt = attempts.find((a) => a.id === artifact.attemptId)!
    return {
      scenario: artifact.scenario!,
      role: roles.get(artifact.stepId) as 'tester' | 'reproducer',
      result:
        artifact.scenarioResult ??
        (attempt.outcome === 'passed'
          ? 'passed'
          : attempt.outcome === 'reproduced'
            ? 'reproduced'
            : 'not recorded'),
      commit: artifact.observedCommit ?? attempt.headCommit,
      artifactId: artifact.id,
      current:
        head !== null &&
        (artifact.observedCommit ?? attempt.headCommit) === head &&
        !attempts.some(
          (a) =>
            a.id > attempt.id &&
            roles.get(a.stepId) === roles.get(artifact.stepId) &&
            a.waitingFor === null,
        ),
    }
  })
}
