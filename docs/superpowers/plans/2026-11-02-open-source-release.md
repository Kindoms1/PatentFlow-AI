# PatentFlow AI open-source release plan

**Goal:** Publish the runnable product as `anticipate218/PatentFlow-AI`, under Apache-2.0, with reproducible tests and a separately configured invitation-only Cloudflare deployment.

**Architecture:** Keep React/Vite, the server-side model/search gateway, and the Cloudflare Worker. Publish implementation source and synthetic fixtures only. Test credentials remain in ignored local files; production credentials require separate operator configuration. Do not describe a static preview as a working AI service.

**Tech stack:** Node.js 24, React, TypeScript, Vite, Cloudflare Workers, Node test runner.

- [x] Confirm repository name and Apache-2.0 with the owner.
- [x] Run original unit tests and record a local baseline.
- [ ] Audit publishable files, dependency/asset attribution, and ignore private work products.
- [ ] Add secret scanning with failure tests and CI; scan source, Git index, and built assets before publication.
- [ ] Harden Worker request limits/authentication/stream handling and include Worker tests/type checking in verification.
- [ ] Test the official DeepSeek endpoint using the testing key, without sending it to other upstreams.
- [ ] Exercise file extraction, search, drafting, revision, figures, DOCX/ZIP exports, and UI navigation; record successes, failures, and gaps separately.
- [ ] Document setup, deployment, privacy, known limits, and the public test matrix.
- [ ] Build and test a clean source checkout; publish only after reviewable evidence is available.
- [ ] Clone the published GitHub repository, run its checks, and verify CI.
- [ ] Deploy only after Cloudflare login and separate production secrets are available; run the same critical user flows against the deployed URL.

## Acceptance evidence

Each test report must state the tested revision/environment, actual command or interaction, exit status, and remaining gaps. Mock upstream tests do not count as live model/search validation. Automated DOCX checks do not establish perfect visual layout or legal/patent eligibility. Record deployment blockers instead of inventing an online link.
