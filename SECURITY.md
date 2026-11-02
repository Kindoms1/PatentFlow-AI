# Security and privacy

- Never commit `.env*`, `.dev.vars*`, `.credentials.json`, uploaded materials, generated patent documents, or local test reports. `.env.example` contains names and public endpoints only.
- Model/search keys belong on the server. Never put secrets in `VITE_*` variables, source files, browser storage, URLs, GitHub Issues, or screenshots.
- `npm run release:scan` checks publishable source; `npm run release:scan:dist` checks built assets. Locally known secrets are compared without printing their values. These checks are defense in depth, not a guarantee against every credential format.
- Case material is stored in the browser. Model operations send selected text to the configured model provider; search and URL extraction send queries/URLs to the configured search provider. Inspect the provider's data policy before using confidential inventions.
- The Vite development server includes local credential management and CC Switch integration. Bind it to localhost. Do not expose it through a public tunnel as a hosted service. Use the Worker deployment for invited users.
- Worker invitation cookies are signed and HttpOnly. Removing an invitation code revokes that code's sessions. Rotating SESSION_SECRET signs everyone out.
- The in-memory request limiter is best-effort per isolate, not a global spending cap. Use restricted production keys and provider-side budget controls.
- Test keys are never automatically promoted to production. Revoke exposed or completed-test credentials at the provider.

For vulnerabilities, use GitHub private vulnerability reporting if the repository enables it. Otherwise contact the maintainer privately before posting reproduction details. Do not post actual keys or private patent materials in public issues.
