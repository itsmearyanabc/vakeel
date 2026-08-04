import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { maskPhone } from '../common/logger';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { UsersService } from '../users/users.service';
import { WhatsAppApiService } from '../whatsapp/whatsapp-api.service';
import { AdminGuard } from './admin.guard';

/**
 * Minimal admin surface.
 *
 * Exists because bar council verification is otherwise a dead end - an advocate
 * submits their enrolment number and nothing can ever approve it. These are the
 * endpoints the governance portal will call; until it exists they are usable
 * directly with curl (see the README).
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly userRepo: UserRepository,
    private readonly analytics: AnalyticsRepository,
    private readonly corpus: CorpusRepository,
    private readonly whatsapp: WhatsAppApiService,
  ) {}

  /** Platform counters for the dashboard. */
  @Get('stats')
  async stats(@Query('days') days?: string) {
    const [platform, corpus] = await Promise.all([
      this.analytics.platformStats(days ? Number(days) : 7),
      this.corpus.countCorpus(),
    ]);
    return { platform, corpus };
  }

  /** Verification review queue. */
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
    await this.whatsapp.sendText(
      user.phone_number,
      '*Your account is verified.*\n\nYou now have unlimited daily queries. Ask me anything about Indian law.',
    );

    return { updated: true, role: user.role };
  }

  @Post('verifications/:userId/reject')
  async reject(@Param('userId') userId: string, @Body() body: { notes: string }) {
    const user = await this.users.reject(userId, body?.notes ?? 'Details could not be verified');
    if (!user) return { updated: false };

    await this.whatsapp.sendText(
      user.phone_number,
      `Your verification could not be completed.\n\n_${body?.notes ?? 'Details could not be verified'}_\n\nType *verify* to try again with corrected details.`,
    );

    return { updated: true };
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

  /** Manual trigger for the DPDP retention sweep (also runs nightly). */
  @Post('retention/purge')
  async purge() {
    return this.analytics.purgeExpired();
  }
}
