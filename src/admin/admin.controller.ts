import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { maskPhone } from '../common/logger';
import { CreditPlanPeriod } from '../database/types';
import { CreditsService } from '../credits/credits.service';
import { DatabaseService } from '../database/database.service';
import { AdminRepository } from '../database/repositories/admin.repository';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { ChatRepository } from '../database/repositories/chat.repository';
import { CreditRepository } from '../database/repositories/credit.repository';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { PlanRepository } from '../database/repositories/plan.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { JobQueueService } from '../jobs/job-queue.service';
import { EcourtsService } from '../ecourts/ecourts.service';
import { KanoonService } from '../kanoon/kanoon.service';
import { SETTING_DEFINITIONS, SETTING_GROUPS } from '../settings/settings.catalog';
import { SettingsService } from '../settings/settings.service';
import { WhatsAppConnectionTester } from '../settings/whatsapp-tester.service';
import { UsersService } from '../users/users.service';
import { WhatsAppApiService } from '../whatsapp/whatsapp-api.service';
import { AdminGuard } from './admin.guard';
import { AuthenticatedRequest } from './admin.guard';

const int = (v: string | undefined, fallback: number, max = 500): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

/**
 * The admin API behind the governance panel.
 *
 * Everything here is guarded by a shared bearer token (see AdminGuard). The HTML
 * shell itself is served unguarded by AdminUiController - a browser cannot
 * attach an Authorization header to a plain navigation, so the page loads first
 * and then authenticates every API call with the token you paste at login.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly userRepo: UserRepository,
    private readonly analytics: AnalyticsRepository,
    private readonly adminRepo: AdminRepository,
    private readonly creditRepo: CreditRepository,
    private readonly planRepo: PlanRepository,
    private readonly creditsService: CreditsService,
    private readonly chatRepo: ChatRepository,
    private readonly corpus: CorpusRepository,
    private readonly whatsapp: WhatsAppApiService,
    private readonly settings: SettingsService,
    private readonly tester: WhatsAppConnectionTester,
    private readonly kanoon: KanoonService,
    private readonly ecourts: EcourtsService,
    private readonly queue: JobQueueService,
    private readonly db: DatabaseService,
  ) {}

  // --- Dashboard ------------------------------------------------------------

  /** Single round trip for the whole dashboard, so the page paints once. */
  @Get('dashboard')
  async dashboard(@Query('days') days?: string) {
    const window = int(days, 14, 90);

    const [platform, corpus, series, intents, messages, pending] = await Promise.all([
      this.analytics.platformStats(window),
      this.corpus.countCorpus(),
      this.adminRepo.timeSeries(window),
      this.adminRepo.intentBreakdown(window),
      this.adminRepo.messageStats(window),
      this.users.listPending(),
    ]);

    return {
      window,
      platform,
      corpus,
      series,
      intents,
      messages,
      pendingVerifications: pending.length,
      whatsapp: {
        configured: this.settings.whatsappConfigured,
        phoneNumberId: this.settings.whatsappPhoneNumberId || null,
      },
      providers: {
        synthesis: this.settings.get('LLM_SYNTHESIS_PROVIDER') || 'mock',
        router: this.settings.get('LLM_ROUTER_PROVIDER') || 'mock',
        embedding: this.settings.get('EMBEDDING_PROVIDER') || 'mock',
      },
      // Without this the dashboard cannot tell whether an empty local corpus
      // actually matters: with Indian Kanoon configured it is irrelevant, and
      // telling the operator to run an ingestion they do not need is worse
      // than saying nothing.
      precedents: {
        source: this.settings.get('PRECEDENT_SOURCE') || 'auto',
        kanoonConfigured: this.kanoon.isConfigured,
        kanoonDegraded: this.kanoon.isDegraded,
        /** True when precedent search genuinely depends on the local corpus. */
        needsLocalCorpus: !this.kanoon.isConfigured || this.settings.get('PRECEDENT_SOURCE') === 'local',
      },
    };
  }

  /** Kept from the pre-panel API; the dashboard endpoint supersedes it. */
  @Get('stats')
  async stats(@Query('days') days?: string) {
    const [platform, corpus] = await Promise.all([
      this.analytics.platformStats(int(days, 7, 90)),
      this.corpus.countCorpus(),
    ]);
    return { platform, corpus };
  }

  // --- Tables ---------------------------------------------------------------

  @Get('users')
  async listUsers(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') search?: string,
  ) {
    return this.adminRepo.listUsers(int(limit, 50), int(offset, 0) || 0, search?.trim() || undefined);
  }

  @Get('searches')
  async listSearches(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('flagged') flagged?: string,
  ) {
    return this.adminRepo.listSearches(int(limit, 50), int(offset, 0) || 0, flagged === 'true');
  }

  @Get('messages')
  async listMessages(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('phone') phone?: string,
  ) {
    return this.adminRepo.listMessages(int(limit, 50), int(offset, 0) || 0, phone?.trim() || undefined);
  }

  @Get('corpus')
  async corpusBreakdown() {
    const [totals, byCourt] = await Promise.all([
      this.corpus.countCorpus(),
      this.adminRepo.corpusBreakdown(),
    ]);
    return { totals, byCourt };
  }

  @Get('audit')
  async audit() {
    return this.adminRepo.listSettingsAudit(100);
  }

  // --- Verification queue ---------------------------------------------------

  @Get('verifications')
  async pending() {
    const users = await this.users.listPending();

    return Promise.all(
      users.map(async (user) => ({
        id: user.id,
        // Masked in the list view; the full number is only revealed on the
        // detail endpoint, which is a deliberate minimisation step.
        phone: maskPhone(user.phone_number),
        full_name: user.full_name,
        bar_council_id: await this.users.revealBarCouncilId(user),
        bar_council_state: user.bar_council_state,
        id_card_storage_path: user.id_card_storage_path,
        submitted_at: user.updated_at,
      })),
    );
  }

  @Post('verifications/:userId/approve')
  async approve(@Param('userId') userId: string, @Body() body: { notes?: string }) {
    const user = await this.users.approve(userId, body?.notes ?? null);
    if (!user) return { updated: false };

    // Tell the advocate immediately - the whole point of verifying is the
    // unlimited quota, and they cannot see the change otherwise.
    //
    // Web-only accounts have no number to message. They are not skipped
    // silently: `notified` is returned so the panel can say the approval
    // landed but the advocate was not told, rather than implying a message
    // went out that never did.
    if (user.phone_number) {
      await this.whatsapp.sendText(
        user.phone_number,
        '*Your account is verified.*\n\nYour licence is confirmed on this account. Ask me anything about Indian law.',
      );
    }

    return { updated: true, role: user.role, notified: Boolean(user.phone_number) };
  }

  @Post('verifications/:userId/reject')
  async reject(@Param('userId') userId: string, @Body() body: { notes: string }) {
    const user = await this.users.reject(userId, body?.notes ?? 'Details could not be verified');
    if (!user) return { updated: false };

    if (user.phone_number) {
      await this.whatsapp.sendText(
        user.phone_number,
        `Your verification could not be completed.\n\n_${body?.notes ?? 'Details could not be verified'}_\n\nType *verify* to try again with corrected details.`,
      );
    }

    return { updated: true, notified: Boolean(user.phone_number) };
  }

  /** Promote a user, e.g. to LEGAL_AUDITOR for the review workflow. */
  @Post('users/:userId/role')
  async setRole(
    @Param('userId') userId: string,
    @Body() body: { role: 'GUEST_LAWYER' | 'VERIFIED_ADVOCATE' | 'LEGAL_AUDITOR' | 'SUPER_ADMIN' },
  ) {
    await this.userRepo.setRole(userId, body.role);
    return { updated: true };
  }

  // --- Settings -------------------------------------------------------------

  /**
   * The catalogue plus current state.
   *
   * Secret values are never returned - only whether one is set and a four
   * character hint, which is enough to tell two tokens apart without disclosing
   * either.
   */
  @Get('settings')
  settingsList() {
    return {
      groups: SETTING_GROUPS,
      definitions: SETTING_DEFINITIONS,
      values: this.settings.describeAll(),
    };
  }

  /**
   * Refuses every write. Configuration is environment-only.
   *
   * Kept rather than deleted so an existing script gets a 409 and an
   * explanation instead of a 404 that reads like a broken deployment. See
   * SettingsService.set() for why nothing is writable.
   */
  @Post('settings')
  @HttpCode(HttpStatus.CONFLICT)
  async saveSettings(@Body() body: Record<string, string>) {
    const { applied, rejected } = await this.settings.setMany(body ?? {}, 'admin-panel');
    return {
      updated: false,
      applied,
      rejected,
      rejectedReason:
        'Settings are read-only. Every value is configured through environment variables on the ' +
        'hosting platform - change it there and redeploy.',
    };
  }

  @Delete('settings/:key')
  async clearSetting(@Param('key') key: string) {
    await this.settings.clear(key, 'admin-panel');
    return { cleared: true, key };
  }

  /** Live credential check against Meta, for the Settings page button. */
  @Post('settings/whatsapp/test')
  async testWhatsApp() {
    return this.tester.test();
  }

  /**
   * Send a real message to a number you control, to prove the loop end to end.
   *
   * The connection test only proves the credentials are valid; this proves the
   * bot can actually deliver. Note that WhatsApp will not accept a free-form
   * message to someone who has not messaged you in the last 24 hours - see the
   * 24-hour window note in brain.md.
   */
  @Post('settings/whatsapp/send-test')
  async sendTest(@Body() body: { to: string; message?: string }) {
    const to = (body?.to ?? '').replace(/\D/g, '');
    if (!to) {
      return { ok: false, error: 'Provide a destination number in international format, digits only.' };
    }

    const result = await this.whatsapp.sendText(
      to,
      body?.message?.trim() ||
        '*Vakeel Saathi test message*\n\nIf you can read this, the WhatsApp connection is working.',
    );

    return {
      ok: result.ok,
      error: result.error ?? null,
      waMessageId: result.waMessageId ?? null,
      hint:
        !result.ok && /24|window|re-?engage/i.test(result.error ?? '')
          ? 'WhatsApp only allows free-form messages within 24 hours of the user last messaging you. Message the bot from that number first, then retry.'
          : null,
    };
  }

  /**
   * Runtime health: queue depth, dependencies, process stats.
   *
   * The queue numbers are the operationally important ones. A rising `waiting`
   * with a flat `completed` means the worker is dead or stuck - which otherwise
   * presents to users as "the bot received my message and never replied", with
   * nothing in the web logs to explain it.
   */
  @Get('system')
  async system() {
    const [queue, database] = await Promise.all([
      this.queue.stats().catch(() => ({}) as Record<string, number>),
      this.db.ping().catch(() => false),
    ]);

    const memory = process.memoryUsage();

    return {
      queue,
      dependencies: { database },
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        environment: this.settings.get('NODE_ENV') || 'unknown',
        heapUsedMb: Math.round(memory.heapUsed / 1048576),
        heapTotalMb: Math.round(memory.heapTotal / 1048576),
        rssMb: Math.round(memory.rss / 1048576),
      },
      config: {
        whatsappConfigured: this.settings.whatsappConfigured,
        whatsappPhoneNumberId: this.settings.whatsappPhoneNumberId || null,
        precedentSource: this.settings.get('PRECEDENT_SOURCE') || 'auto',
        kanoonConfigured: this.kanoon.isConfigured,
        kanoonDegraded: this.kanoon.isDegraded,
        synthesisProvider: this.settings.get('LLM_SYNTHESIS_PROVIDER') || 'mock',
        routerProvider: this.settings.get('LLM_ROUTER_PROVIDER') || 'mock',
        embeddingProvider: this.settings.get('EMBEDDING_PROVIDER') || 'mock',
        memoryEnabled: this.settings.getBoolean('MEMORY_ENABLED', true),
        /*
         * eCourts, including the fault an outage indicator cannot show.
         *
         * A wrong base URL or a rejected key does not open the circuit - there
         * is nothing to retry - so `degraded` stays false while every lookup
         * fails. Without `configurationError` the panel reports a service as
         * healthy when it is answering nobody, which is precisely how one
         * deployment ran for a day pointed at the provider's marketing site.
         */
        ecourtsMode: this.settings.get('ECOURTS_MODE') || 'mock',
        ecourtsDegraded: this.ecourts.isDegraded,
        ecourtsConfigurationError: this.ecourts.configurationError,
      },
    };
  }

  // --- Credits --------------------------------------------------------------

  /**
   * The ledger, plus totals for the window.
   *
   * Totals are summed from `credit_ledger` rather than from the cached columns
   * on `users`, because the ledger is the authoritative record and this is the
   * report that would reveal a divergence between the two.
   */
  @Get('credits')
  async credits(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('days') days?: string,
    @Query('userId') userId?: string,
  ) {
    const [entries, totals] = await Promise.all([
      this.creditRepo.recentEntries(int(limit, 50), int(offset, 0) || 0, userId?.trim() || undefined),
      this.creditRepo.totals(int(days, 30, 365)),
    ]);

    return { entries, totals, window: int(days, 30, 365) };
  }

  /**
   * Grant credits by hand.
   *
   * Lands in the durable bucket, so a grant made to compensate for a bad answer
   * is not silently wiped by the nightly free-credit rollover a few hours later.
   *
   * `idempotencyKey` is required rather than generated here: it has to survive
   * the request being retried, and a value invented server-side is different on
   * every attempt, which is precisely the case it exists to protect against.
   * The panel sends one per press of the button.
   */
  @Post('credits/grant')
  async grantCredits(
    @Body() body: { userId?: string; amount?: number; reason?: string; idempotencyKey?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const amount = Number(body?.amount);

    if (!body?.userId || !Number.isInteger(amount) || amount <= 0 || amount > 100_000) {
      throw new BadRequestException({
        code: 'INVALID_GRANT',
        message: 'Provide a user and a whole number of credits between 1 and 100000.',
      });
    }

    if (!body?.idempotencyKey) {
      throw new BadRequestException({
        code: 'NO_IDEMPOTENCY_KEY',
        message: 'An idempotencyKey is required so a retried grant cannot be applied twice.',
      });
    }

    const result = await this.creditsService.adminGrant({
      userId: body.userId,
      amount,
      reason: body.reason?.trim() || 'Granted by an administrator',
      grantedBy: req.admin?.email ?? 'unknown',
      idempotencyKey: body.idempotencyKey,
    });

    // `applied: false` means the key had already been used. Reported rather
    // than hidden, so the operator knows the second click did nothing instead
    // of wondering why the balance did not move again.
    return result;
  }

  /**
   * Take credits back.
   *
   * The mirror of {@link grantCredits}, and it existed in CreditsService with
   * no route to reach it - so an administrator could hand credits out and had
   * no way to correct a mistake except by asking the advocate not to spend them.
   *
   * Floors at the available balance rather than refusing: a deduction larger
   * than what is left means the advocate already spent it, and rejecting the
   * whole operation would leave nothing correctable at all. The amount actually
   * taken comes back, so the panel can say what happened rather than implying
   * the full figure moved.
   */
  @Post('credits/deduct')
  async deductCredits(
    @Body() body: { userId?: string; amount?: number; reason?: string; idempotencyKey?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const amount = Number(body?.amount);

    if (!body?.userId || !Number.isInteger(amount) || amount <= 0 || amount > 100_000) {
      throw new BadRequestException({
        code: 'INVALID_DEDUCTION',
        message: 'Provide a user and a whole number of credits between 1 and 100000.',
      });
    }

    if (!body?.idempotencyKey) {
      throw new BadRequestException({
        code: 'NO_IDEMPOTENCY_KEY',
        message: 'An idempotencyKey is required so a retried deduction cannot be applied twice.',
      });
    }

    return this.creditsService.adminDeduct({
      userId: body.userId,
      amount,
      reason: body.reason?.trim() || 'Adjusted by an administrator',
      deductedBy: req.admin?.email ?? 'unknown',
      idempotencyKey: body.idempotencyKey,
    });
  }

  // --- Pricing --------------------------------------------------------------
  //
  // The one part of the panel that writes, and the exception is deliberate.
  // Settings are environment-only because values saved there were overriding
  // the environment or being read by nothing at all. A price list is not
  // configuration: it has identity, an archive flag, and orders that resolve
  // against it months later. Changing a price is a business action of the same
  // kind as granting credits, which the panel has always been allowed to do.
  //
  // Plans are archived, never deleted - `credit_orders.plan_id` has to keep
  // explaining what somebody paid for two years from now.

  /** Every plan, archived ones included, in display order. */
  @Get('plans')
  async listPlans() {
    return {
      plans: await this.planRepo.listAll(),
      gateway: {
        configured: this.settings.razorpayConfigured,
        gstRateBps: this.settings.gstRateBps,
      },
    };
  }

  /**
   * Create or change a plan.
   *
   * One route rather than a create and an update, matching PlanRepository.upsert:
   * the panel is one form, and an operator does not think of "change the price
   * of Starter" as a different operation from "define Starter".
   *
   * The whole plan is sent every time. A partial update would have to merge, and
   * a merge that silently drops a field sets a price to whatever was there
   * before - which is the one mistake in this file that costs money.
   */
  @Post('plans')
  async savePlan(@Body() body: Record<string, unknown>) {
    const input = readPlan(body, this.settings.gstRateBps);
    return this.planRepo.upsert(input);
  }

  /** Take a plan off sale without archiving it. */
  @Post('plans/:id/active')
  async setPlanActive(@Param('id') id: string, @Body() body: { active?: boolean }) {
    const updated = await this.planRepo.setActive(id, Boolean(body?.active));
    if (!updated) {
      throw new BadRequestException({ code: 'NO_PLAN', message: 'No plan with that id.' });
    }
    return updated;
  }

  /** Retire a plan. Never a hard delete - see PlanRepository. */
  @Delete('plans/:id')
  async archivePlan(@Param('id') id: string) {
    const archived = await this.planRepo.archive(id);
    if (!archived) {
      throw new BadRequestException({
        code: 'NO_PLAN',
        message: 'No plan with that id, or it is already archived.',
      });
    }
    return { archived: true };
  }

  /**
   * Purchases, and the one query that matters operationally.
   *
   * `uncredited` lists orders the gateway reports as paid that never produced
   * credits. Every other failure in a payment flow is visible to the person
   * paying; this one is invisible to them and to us unless something looks for
   * it. It is empty until Razorpay is wired up, and it is here now so that it
   * is not discovered as a missing report after the first real payment.
   */
  @Get('orders')
  async orders(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const [orders, uncredited] = await Promise.all([
      this.creditRepo.listOrders(int(limit, 50), int(offset, 0) || 0),
      this.creditRepo.uncreditedOrders(20),
    ]);

    return {
      orders,
      uncredited,
      gateway: {
        configured: this.settings.razorpayConfigured,
        gstRateBps: this.settings.gstRateBps,
      },
    };
  }

  // --- Web application ------------------------------------------------------

  /** Web conversations across all users, for support and quality review. */
  @Get('chats')
  async chats(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.chatRepo.recentThreadsForAdmin(int(limit, 50), int(offset, 0) || 0);
  }

  /**
   * One conversation in full.
   *
   * Deliberately not owner-scoped - that is the point of an admin view - which
   * is also why it is worth being explicit that this reads an advocate's legal
   * research. It exists for support ("the bot gave me a wrong citation") and
   * for the auditor role the schema already defines.
   */
  @Get('chats/:threadId')
  async chatThread(@Param('threadId') threadId: string) {
    return this.chatRepo.messagesForAdmin(threadId);
  }

  // --- Maintenance ----------------------------------------------------------

  /** Manual trigger for the DPDP retention sweep (also runs nightly). */
  @Post('retention/purge')
  async purge() {
    return this.analytics.purgeExpired();
  }
}

/**
 * Read and check a plan from a request body.
 *
 * Prices arrive in rupees because that is what an operator types, and are
 * stored as integer paise because that is what the gateway and every other
 * money column use. The conversion happens here, once - a division by 100 in
 * the wrong place is a rounding error in somebody's money.
 *
 * The tax split is computed rather than asked for. `credit_plans` constrains
 * base + tax = price, so a form that let those be typed independently would
 * reject a perfectly reasonable set of numbers for being a paisa out, and the
 * operator would have no idea which of the three to change.
 */
const PLAN_PERIODS: CreditPlanPeriod[] = ['ONE_TIME', 'MONTHLY', 'ANNUAL'];

function readPlan(
  body: Record<string, unknown>,
  gstRateBps: number,
): {
  code: string;
  name: string;
  description: string | null;
  credits: number;
  basePaise: number;
  taxRateBps: number;
  taxPaise: number;
  pricePaise: number;
  badge: string | null;
  billingPeriod: CreditPlanPeriod;
  sortOrder: number;
  isActive: boolean;
} {
  const code = String(body.code ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(code)) {
    throw new BadRequestException({
      code: 'INVALID_CODE',
      message: 'Code must be 2-40 characters of lowercase letters, numbers and hyphens.',
    });
  }

  const name = String(body.name ?? '').trim();
  if (!name) {
    throw new BadRequestException({ code: 'NO_NAME', message: 'Give the plan a name.' });
  }

  const credits = Number(body.credits);
  if (!Number.isInteger(credits) || credits <= 0 || credits > 1_000_000) {
    throw new BadRequestException({
      code: 'INVALID_CREDITS',
      message: 'Credits must be a whole number between 1 and 1000000.',
    });
  }

  const rupees = Number(body.priceRupees);
  if (!Number.isFinite(rupees) || rupees <= 0 || rupees > 10_000_000) {
    throw new BadRequestException({
      code: 'INVALID_PRICE',
      message: 'Price must be a positive amount in rupees.',
    });
  }

  // A price finer than a paisa cannot be charged, so it is a typo rather than
  // something to round away quietly.
  const pricePaise = Math.round(rupees * 100);
  if (Math.abs(rupees * 100 - pricePaise) > 1e-6) {
    throw new BadRequestException({
      code: 'INVALID_PRICE',
      message: 'Price cannot be finer than one paisa.',
    });
  }

  const period = String(body.billingPeriod ?? 'ONE_TIME').toUpperCase() as CreditPlanPeriod;
  if (!PLAN_PERIODS.includes(period)) {
    throw new BadRequestException({
      code: 'INVALID_PERIOD',
      message: 'Billing period must be one of ' + PLAN_PERIODS.join(', ') + '.',
    });
  }

  // Derived by subtraction so the two always add to the price, which is what
  // the credit_plans_amount_adds_up constraint requires.
  const rate = Number.isFinite(gstRateBps) && gstRateBps > 0 ? gstRateBps : 0;
  const basePaise = rate > 0 ? Math.round((pricePaise * 10_000) / (10_000 + rate)) : pricePaise;

  const sortOrder = Number(body.sortOrder ?? 0);

  return {
    code,
    name,
    description: String(body.description ?? '').trim() || null,
    credits,
    basePaise,
    taxRateBps: rate,
    taxPaise: pricePaise - basePaise,
    pricePaise,
    badge: String(body.badge ?? '').trim() || null,
    billingPeriod: period,
    sortOrder: Number.isInteger(sortOrder) ? sortOrder : 0,
    isActive: body.isActive === undefined ? true : Boolean(body.isActive),
  };
}
