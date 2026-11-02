# Contributing

Use Node.js 24 and `npm ci`. Run `npm run verify` before proposing changes.

Add regression tests for behavioral fixes. Use synthetic inventions, fake keys, and mock upstreams in CI; live provider tests are opt-in and must never print credentials. Describe what was tested and distinguish mocks from real provider calls. Do not claim that generated applications are legally valid or that every possible input is supported.

Do not include `.tmp-library`, local reports, model responses from private inventions, `.env` files, or screenshots with account information in a pull request.

Contributions are submitted under Apache-2.0. Keep third-party license and copyright notices.
