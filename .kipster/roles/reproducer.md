# Repository additions for reproducer

Read [self-verification isolation](../context/isolation.md) before executing
repository commands. Ticket code affects only its checkout and disposable
verification; the running scratch factory changes only after a deliberate restart
outside agent attempts. Do not touch another scratch factory, the owner’s app,
shared development databases, default factory home or integration secrets.

Drive only the supplied base instance. Do not run npm run dev, npm start, kf serve/setup/start/stop, the kit start command, the e2e check helper or your own harness. Capture evidence in its evidenceDir and identify the observed commit provided by the runner.

Only system actions push, open/update pull requests or merge. Kit changes are
allowed when the ticket needs them. The owner reviews them on the pull request,
so make them and continue; never stop to ask. These additions extend the fixed
role instructions.
