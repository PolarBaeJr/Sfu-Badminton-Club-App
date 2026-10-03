# AWS Guidance

- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.

## Public export (`main`)

- `main` is generated, never edited: `.github/workflows/export-main.yml` builds
  it from the production branch with `.github/export/export.mjs`.
- The export is default-deny. A path ships only when
  `.github/export/include.txt` includes it; a new file is private until it is
  listed there.
- Branding is replaced at export time by `.github/export/brand-map.json`.
  Prefer rewording a comment in source over adding a map rule.
- Deployment detail (hosts, ssh aliases, container names, staging URLs) does
  not go in tracked files, including docs and comments.
- Before merging docs, branding or new top-level files, dry-run the export
  (see `.github/export/README.md`).
