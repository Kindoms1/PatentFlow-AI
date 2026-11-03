# Security and privacy

- Never commit `.env*`, `.dev.vars*`, `.credentials.json`, uploaded materials, generated patent documents, or local test reports. `.env.example` contains names and public endpoints only.
- Administrator model/search keys belong on the server. Never put these shared secrets in `VITE_*` variables, source files, browser storage, URLs, GitHub Issues, or screenshots.
- Invited users may supply their own model keys (BYOK). These default to page memory, with explicit opt-in to unencrypted sessionStorage. Only non-secret profile metadata goes in localStorage. Session restore may restore a tab's sessionStorage; remove a saved profile to clear its retained key, and avoid retention on shared computers.
- BYOK sends the user's key through this site's gateway to the selected model service. The gateway does not persist personal keys or place them in model messages. Users must trust both operators. Use restricted, low-budget keys. Request bodies must never be recorded by external logs or analytics.
- BYOK permits only HTTPS destinations on the exact built-in/operator-approved hostname list. IP literals, arbitrary ports, URL credentials/query parameters and unapproved hosts are rejected; redirects are not followed. Only add domains you control or trust to BYOK_ALLOWED_HOSTS. Shared administrator credentials are never used with a user-supplied endpoint.
- `npm run release:scan` checks publishable source; `npm run release:scan:dist` checks built assets. Locally known secrets are compared without printing their values. These checks are defense in depth, not a guarantee against every credential format.
- Case material is stored in the browser. Model operations send selected text to the configured model provider; search and URL extraction send queries/URLs to the configured search provider. Inspect the provider's data policy before using confidential inventions.
- The Vite development server includes local credential management and CC Switch integration. Bind it to localhost. Do not expose it through a public tunnel as a hosted service. Use the Worker deployment for invited users.
- Worker invitation cookies are signed and HttpOnly. Removing an invitation code revokes that code's sessions. Rotating SESSION_SECRET signs everyone out.
- The in-memory request limiter is best-effort per isolate, not a global spending cap. Use restricted production keys and provider-side budget controls.
- Test keys are never automatically promoted to production. Revoke exposed or completed-test credentials at the provider.

For vulnerabilities, use GitHub private vulnerability reporting if the repository enables it. Otherwise contact the maintainer privately before posting reproduction details. Do not post actual keys or private patent materials in public issues.
