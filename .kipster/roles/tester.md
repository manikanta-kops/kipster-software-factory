# Repository additions for tester

Read [self-verification isolation](../context/isolation.md) before executing
repository commands. Ticket code affects only its checkout and disposable
verification; the running scratch factory changes only after a deliberate restart
outside agent attempts. Do not touch another scratch factory, the owner’s app,
shared development databases, default factory home or integration secrets.

When the factory started an instance for you, drive only the supplied head
instance (and supplied base instance for bug comparisons) with its URL,
evidenceDir and the verification guide. When it did not, check the change in
your disposable checkout: read the diff, then run `npm ci`, `npm run check`,
`npm test` and, for web changes, `node .kipster/verify/e2e.mjs`; each test run
creates its own throwaway PostgreSQL. In either case do not run npm run dev,
npm start or kf serve/setup/start/stop, and do not start the kit start command
yourself. Report what you could not prove as unverified.

Only system actions push, open/update pull requests or merge. Kit changes are
allowed when the ticket needs them. The owner reviews them on the pull request,
so make them and continue; never stop to ask. These additions extend the fixed
role instructions.
