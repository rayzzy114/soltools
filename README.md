v_alpha.0.0.2

DB / Prisma
- Local schema sync: `npx prisma db push`
- Mark manual migration as applied: `npx prisma migrate resolve --applied <migration_name>`
- Production deploy: `npx prisma migrate deploy`
- Note: `migrate dev` may fail on Windows + Docker (shadow DB connectivity); use `db push` locally.
- zakazchik dolzhen napisat' eto: `npx prisma migrate deploy; npx prisma generate`