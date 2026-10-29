import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Names of the PostgreSQL session settings that the RLS policies in
 * `prisma/migrations/*_init/migration.sql` read. Every tenant-scoped query must
 * run inside a transaction that first sets the relevant setting with
 * `set_config(..., is_local := true)` (the parameterised form of `SET LOCAL`).
 */
export const RLS_SETTINGS = {
  tenantId: 'app.tenant_id',
  userId: 'app.user_id',
  webhookPathId: 'app.webhook_path_id',
  context: 'app.context',
} as const;

export type RlsContext = 'auth' | 'webhook';

export interface TenantScope {
  tenantId?: string;
  userId?: string;
  webhookPathId?: string;
  context?: RlsContext;
}

export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
}

/**
 * Runs `fn` in a transaction with the RLS session variables set locally, so
 * they are cleared automatically at commit/rollback and can never leak to
 * another pooled connection. Values are bound as parameters, never
 * interpolated into SQL.
 */
export async function withTenantScope<T>(
  prisma: PrismaClient,
  scope: TenantScope,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (scope.tenantId !== undefined) assertUuid(scope.tenantId, 'tenantId');
  if (scope.userId !== undefined) assertUuid(scope.userId, 'userId');
  if (scope.webhookPathId !== undefined && !PATH_ID_RE.test(scope.webhookPathId)) {
    throw new TypeError('webhookPathId has an unexpected format');
  }

  return prisma.$transaction(async (tx) => {
    const settings: [string, string | undefined][] = [
      [RLS_SETTINGS.tenantId, scope.tenantId],
      [RLS_SETTINGS.userId, scope.userId],
      [RLS_SETTINGS.webhookPathId, scope.webhookPathId],
      [RLS_SETTINGS.context, scope.context],
    ];
    for (const [name, value] of settings) {
      if (value !== undefined) {
        await tx.$executeRaw(Prisma.sql`SELECT set_config(${name}, ${value}, true)`);
      }
    }
    return fn(tx);
  });
}
