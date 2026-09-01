import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { CreditPackPeriod, CreditPackRow } from '../types';

/**
 * The price list.
 *
 * ## Why a repository and not SettingsService
 *
 * Settings are environment-only and `SettingsService.set()` refuses every
 * write, for a good reason documented there: values saved in the panel were
 * overriding the environment, or being saved and never read. None of that
 * applies here. A pack has identity, an active flag, and orders that resolve
 * against its code months after it stops being sold - that is data, and the
 * panel writing it is a business action of the same kind as granting credits.
 *
 * ## Retirement, not deletion
 *
 * There is no hard delete. `credit_orders.pack_code` is what an invoice and a
 * dispute resolve against, so a code that stops resolving is a hole in the
 * financial record. {@link deactivate} is what "remove this pack" means.
 */
@Injectable()
export class PackRepository {
  constructor(private readonly db: DatabaseService) {}

  /** What the pricing screen shows: buyable packs, in the operator's order. */
  async listActive(): Promise<CreditPackRow[]> {
    return this.db.sql<CreditPackRow[]>`
      SELECT * FROM credit_packs
       WHERE is_active
       ORDER BY sort_order, price_paise
    `;
  }

  /** Everything, including retired packs. The admin panel's view. */
  async listAll(): Promise<CreditPackRow[]> {
    return this.db.sql<CreditPackRow[]>`
      SELECT * FROM credit_packs
       ORDER BY is_active DESC, sort_order, price_paise
    `;
  }

  /**
   * One pack by code, for checkout.
   *
   * Scoped to active rows on purpose: the price and credit count an order is
   * built from must come from something currently on sale, or a stale tab left
   * open across a price change buys yesterday's pack at yesterday's price.
   */
  async findActiveByCode(code: string): Promise<CreditPackRow | null> {
    const [row] = await this.db.sql<CreditPackRow[]>`
      SELECT * FROM credit_packs WHERE code = ${code} AND is_active LIMIT 1
    `;
    return row ?? null;
  }

  async findByCode(code: string): Promise<CreditPackRow | null> {
    const [row] = await this.db.sql<CreditPackRow[]>`
      SELECT * FROM credit_packs WHERE code = ${code} LIMIT 1
    `;
    return row ?? null;
  }

  async create(input: {
    code: string;
    name: string;
    description: string | null;
    credits: number;
    pricePaise: number;
    billingPeriod: CreditPackPeriod;
    sortOrder: number;
    isFeatured: boolean;
  }): Promise<CreditPackRow> {
    return this.db.sql.begin(async (sql) => {
      // At most one featured pack, enforced by a partial unique index. Clearing
      // the previous one here rather than letting the insert fail is what makes
      // "feature this one" mean what an operator expects.
      if (input.isFeatured) {
        await sql`UPDATE credit_packs SET is_featured = FALSE WHERE is_featured`;
      }

      const [row] = await sql<CreditPackRow[]>`
        INSERT INTO credit_packs
               (code, name, description, credits, price_paise, billing_period, sort_order, is_featured)
        VALUES (${input.code}, ${input.name}, ${input.description}, ${input.credits},
                ${input.pricePaise}, ${input.billingPeriod}::credit_pack_period,
                ${input.sortOrder}, ${input.isFeatured})
        RETURNING *
      `;
      return row;
    });
  }

  /**
   * Change a pack in place.
   *
   * `code` is deliberately not updatable. It is the join between an order and
   * what that order bought, and rewriting it silently re-points every historical
   * order at a pack they did not buy. Renaming a pack means changing `name`;
   * changing what it *is* means retiring it and creating another.
   */
  async update(
    code: string,
    input: {
      name: string;
      description: string | null;
      credits: number;
      pricePaise: number;
      billingPeriod: CreditPackPeriod;
      sortOrder: number;
      isFeatured: boolean;
      isActive: boolean;
    },
  ): Promise<CreditPackRow | null> {
    return this.db.sql.begin(async (sql) => {
      if (input.isFeatured) {
        await sql`UPDATE credit_packs SET is_featured = FALSE WHERE is_featured AND code <> ${code}`;
      }

      const [row] = await sql<CreditPackRow[]>`
        UPDATE credit_packs
           SET name           = ${input.name},
               description    = ${input.description},
               credits        = ${input.credits},
               price_paise    = ${input.pricePaise},
               billing_period = ${input.billingPeriod}::credit_pack_period,
               sort_order     = ${input.sortOrder},
               is_featured    = ${input.isFeatured},
               is_active      = ${input.isActive}
         WHERE code = ${code}
     RETURNING *
      `;
      return row ?? null;
    });
  }

  /** Retire a pack. The row stays so historical orders keep resolving. */
  async deactivate(code: string): Promise<CreditPackRow | null> {
    const [row] = await this.db.sql<CreditPackRow[]>`
      UPDATE credit_packs
         SET is_active = FALSE, is_featured = FALSE
       WHERE code = ${code}
   RETURNING *
    `;
    return row ?? null;
  }
}
