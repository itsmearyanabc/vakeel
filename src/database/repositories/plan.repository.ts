import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { CreditPlanRow } from '../types';

/**
 * Purchasable credit packs.
 *
 * Plans are data rather than code so the price can change without a deploy, and
 * so the person who decides pricing is not the person who can edit TypeScript.
 *
 * Nothing here hard-deletes. An order references the plan it was bought under,
 * and two years from now that row still has to be able to explain what somebody
 * paid for — an archived plan disappears from the pricing page and stays legible
 * in the ledger.
 */
@Injectable()
export class PlanRepository {
  constructor(private readonly db: DatabaseService) {}

  /** What the pricing page renders. Live plans only, in display order. */
  async listActive(): Promise<CreditPlanRow[]> {
    return this.db.sql<CreditPlanRow[]>`
      SELECT * FROM credit_plans
       WHERE is_active AND archived_at IS NULL
       ORDER BY sort_order, price_paise
    `;
  }

  /** Everything, including archived, for the admin panel. */
  async listAll(): Promise<CreditPlanRow[]> {
    return this.db.sql<CreditPlanRow[]>`
      SELECT * FROM credit_plans ORDER BY archived_at NULLS FIRST, sort_order, price_paise
    `;
  }

  async findByCode(code: string): Promise<CreditPlanRow | null> {
    const [row] = await this.db.sql<CreditPlanRow[]>`
      SELECT * FROM credit_plans WHERE code = ${code} LIMIT 1
    `;
    return row ?? null;
  }

  async findById(id: string): Promise<CreditPlanRow | null> {
    const [row] = await this.db.sql<CreditPlanRow[]>`
      SELECT * FROM credit_plans WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  /**
   * Create or update a plan by its code.
   *
   * Upsert rather than separate create and update paths, because the admin form
   * is one form and the operator does not think of "change the price of Starter"
   * as a different operation from "define Starter".
   *
   * Changing the price of a live plan is allowed and does not rewrite history:
   * `credit_orders` stores the amount charged at the time, so an old order keeps
   * its old price.
   */
  async upsert(input: {
    code: string;
    name: string;
    description: string | null;
    credits: number;
    basePaise: number;
    taxRateBps: number;
    taxPaise: number;
    pricePaise: number;
    badge: string | null;
    sortOrder: number;
    isActive: boolean;
  }): Promise<CreditPlanRow> {
    const [row] = await this.db.sql<CreditPlanRow[]>`
      INSERT INTO credit_plans
             (code, name, description, credits, base_paise, tax_rate_bps, tax_paise,
              price_paise, badge, sort_order, is_active)
      VALUES (${input.code}, ${input.name}, ${input.description}, ${input.credits},
              ${input.basePaise}, ${input.taxRateBps}, ${input.taxPaise},
              ${input.pricePaise}, ${input.badge}, ${input.sortOrder}, ${input.isActive})
      ON CONFLICT (code) DO UPDATE
              SET name         = EXCLUDED.name,
                  description  = EXCLUDED.description,
                  credits      = EXCLUDED.credits,
                  base_paise   = EXCLUDED.base_paise,
                  tax_rate_bps = EXCLUDED.tax_rate_bps,
                  tax_paise    = EXCLUDED.tax_paise,
                  price_paise  = EXCLUDED.price_paise,
                  badge        = EXCLUDED.badge,
                  sort_order   = EXCLUDED.sort_order,
                  is_active    = EXCLUDED.is_active,
                  -- Saving a plan brings it back from the archive. Doing it any
                  -- other way means an operator edits an archived plan, sees it
                  -- save, and cannot work out why it is still not on sale.
                  archived_at  = NULL
        RETURNING *
    `;
    return row;
  }

  async setActive(id: string, active: boolean): Promise<CreditPlanRow | null> {
    const [row] = await this.db.sql<CreditPlanRow[]>`
      UPDATE credit_plans SET is_active = ${active} WHERE id = ${id} RETURNING *
    `;
    return row ?? null;
  }

  async archive(id: string): Promise<boolean> {
    const rows = await this.db.sql<{ id: string }[]>`
      UPDATE credit_plans
         SET archived_at = NOW(), is_active = FALSE
       WHERE id = ${id} AND archived_at IS NULL
   RETURNING id
    `;
    return rows.length > 0;
  }
}
