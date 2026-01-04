v_alpha.0.0.2

DB / Prisma
- Local schema sync: `npx prisma db push`
- Mark manual migration as applied: `npx prisma migrate resolve --applied <migration_name>`
- Production deploy: `npx prisma migrate deploy`
- Note: `migrate dev` may fail on Windows + Docker (shadow DB connectivity); use `db push` locally.
- zakazchik dolzhen napisat' eto: `npx prisma migrate deploy; npx prisma generate`

  ![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/rayzzy114/soltools?utm_source=oss&utm_medium=github&utm_campaign=rayzzy114%2Fsoltools&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)
