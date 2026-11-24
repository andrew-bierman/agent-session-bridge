# Release Checklist

- Run `bun run release:check`
- Run `bun run build`
- Confirm sanitized fixtures still parse with `bun run fixture:validate`
- Review `docs/HOOKS.md` and `docs/TROUBLESHOOTING.md`
- Verify release notes reflect the latest live validation status
