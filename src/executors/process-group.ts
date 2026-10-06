import { execFileSync } from 'node:child_process'

export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return
    // An exited macOS group can report EPERM. Never suppress it for live members.
    if (code === 'EPERM') {
      const groups = execFileSync('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], {
        encoding: 'utf8',
      })
      const live = groups.split('\n').some((line) => {
        const [group, status] = line.trim().split(/\s+/)
        // A leading Z is a zombie and an E flag means exiting on macOS; neither can still run work.
        return Number(group) === pid && !/^Z|E/.test(status ?? '')
      })
      if (!live) return
    }
    throw error
  }
}
