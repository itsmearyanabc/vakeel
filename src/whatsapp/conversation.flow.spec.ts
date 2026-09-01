import { PrecedentRow, WhatsAppUserRow } from '../database/types';
import { InboundMessageJob } from '../jobs/queue.constants';
import { ConversationService } from './conversation.service';

/**
 * The three flows that ran end to end and did nothing.
 *
 * Each of these was reachable by an advocate on the first day, produced no
 * error anywhere, and failed silently:
 *
 *   - *stop* replied "you will not receive further messages" and did not opt
 *     anybody out, because the handler wrote the user's language back over
 *     itself instead of setting `is_blocked`. There was also no way back in.
 *   - *verify* asked for a bar council enrolment number and then bounced the
 *     answer to the main menu, because the state it set belongs to a machine
 *     nothing was calling. No advocate could get verified over WhatsApp.
 *   - *more* answered "that was the last result" on every search, because the
 *     result set was written to the conversation row and then overwritten by
 *     the router's own write a few lines later.
 *
 * None of them throws, so only a test that drives a whole message through can
 * tell the difference between working and not.
 */

function precedent(id: string): PrecedentRow {
  return {
    judgment_id: id,
    case_title: `Case ${id} v. State`,
    neutral_citation: null,
    reporter_citations: [],
    court_name: 'Supreme Court of India',
    court_type: 'SUPREME_COURT',
    judgment_date: new Date('2024-01-01'),
    bench: [],
    bench_strength: 1,
    act_sections: [],
    headnote: null,
    ratio_decidendi: 'A statement of what the case decided, long enough to print.',
    disposition: 'ALLOWED',
    source_url: null,
    best_excerpt: '',
    para_number: 1,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 12,
  } as PrecedentRow;
}

/** An in-memory stand-in for conversation_states, with its replace-on-write semantics. */
function conversationStore() {
  let row: { state: string; context: Record<string, unknown> } | null = null;
  return {
    rows: () => row,
    seed: (state: string, context: Record<string, unknown> = {}) => {
      row = { state, context };
    },
    get: jest.fn(async () => row),
    set: jest.fn(async (_userId: string, state: string, context: Record<string, unknown> = {}) => {
      row = { state, context };
    }),
    clear: jest.fn(async () => {
      row = null;
    }),
  };
}

function userRow(over: Partial<WhatsAppUserRow> = {}): WhatsAppUserRow {
  return {
    id: 'user-1',
    phone_number: '919876543210',
    full_name: 'Ramesh Kumar',
    bar_council_id_hash: 'hash',
    bar_council_state: 'Bihar',
    city: 'Patna',
    verification_status: 'PENDING',
    role: 'GUEST_LAWYER',
    preferred_language: 'en',
    is_blocked: false,
    ...(over as object),
  } as WhatsAppUserRow;
}

function job(over: Partial<InboundMessageJob> = {}): InboundMessageJob {
  return {
    waMessageId: 'wamid.1',
    from: '919876543210',
    phoneNumberId: 'pn-1',
    timestamp: Math.floor(Date.now() / 1000),
    type: 'text',
    text: 'hello',
    ...over,
  };
}

function build(
  over: {
    user?: WhatsAppUserRow;
    conversations?: ReturnType<typeof conversationStore>;
    precedents?: PrecedentRow[];
    submitBarCouncilId?: jest.Mock;
    intent?: string;
  } = {},
) {
  const conversations = over.conversations ?? conversationStore();
  const found = over.user ?? userRow();

  const api = {
    sendText: jest.fn().mockResolvedValue({ ok: true }),
    send: jest.fn().mockResolvedValue({ ok: true }),
    markAsRead: jest.fn().mockResolvedValue(undefined),
  };
  const users = {
    resolveFromPhone: jest.fn().mockResolvedValue(found),
    setLanguage: jest.fn().mockResolvedValue(undefined),
    setBlocked: jest.fn().mockResolvedValue(undefined),
    completeProfile: jest.fn().mockResolvedValue({ accepted: true, user: found }),
    submitBarCouncilId:
      over.submitBarCouncilId ?? jest.fn().mockResolvedValue({ accepted: true }),
  };
  const intents = {
    classify: jest.fn().mockResolvedValue({
      intent: over.intent ?? 'GENERAL_LEGAL',
      language: 'en',
      cnrNumber: null,
      sectionNumber: null,
      actCode: null,
      searchQuery: 'q',
      confidence: 0.9,
    }),
  };
  const rag = {
    answer: jest.fn().mockResolvedValue({
      text: 'An answer.',
      citations: [],
      passages: [],
      statutes: [],
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 1,
      guardrailTriggered: false,
      guardrailReason: null,
      mocked: false,
    }),
    answerSmallTalk: jest.fn().mockResolvedValue('hi'),
  };
  const precedents = {
    pageSize: 5,
    search: jest.fn().mockResolvedValue({
      precedents: over.precedents ?? [],
      totalMatches: (over.precedents ?? []).length,
      lexicalOnly: false,
      source: 'local' as const,
      latencyMs: 1,
    }),
  };
  const memory = { clear: jest.fn(), load: jest.fn().mockResolvedValue([]), append: jest.fn() };
  const ecourts = { lookup: jest.fn().mockResolvedValue({ cnr: 'X', mocked: true }) };
  const credits = {
    balance: jest.fn().mockResolvedValue({ free: 10, paid: 0, total: 10, monthlyAllowance: 30, unlimited: false }),
    peek: jest.fn().mockResolvedValue({ free: 10, paid: 0, total: 10, monthlyAllowance: 30, unlimited: false }),
    creditLine: jest.fn().mockReturnValue('Credits: 10 left'),
    spend: jest.fn().mockResolvedValue({ allowed: true, charged: 2, replay: false, balance: {} }),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const phoneLink = { redeemCode: jest.fn().mockResolvedValue({ status: 'NO_PENDING_CODE' }) };
  const analytics = { recordSearch: jest.fn().mockResolvedValue(undefined), searchesToday: jest.fn() };
  const transcription = { isAvailable: false, transcribe: jest.fn() };
  const registry = { isFullyMocked: false };
  const env = { SESSION_TTL_SECONDS: 1800, APP_PUBLIC_URL: '' };

  const service = new ConversationService(
    api as never,
    users as never,
    conversations as never,
    intents as never,
    rag as never,
    precedents as never,
    memory as never,
    ecourts as never,
    credits as never,
    phoneLink as never,
    analytics as never,
    transcription as never,
    registry as never,
    env as never,
  );

  return { service, api, users, conversations, precedents, ecourts, memory, credits };
}

/** Everything sent to the handset in one string, for readable assertions. */
function sent(api: { sendText: jest.Mock }): string {
  return api.sendText.mock.calls.map((call) => String(call[1])).join('\n---\n');
}

describe('opting out', () => {
  it('actually blocks the account when the advocate sends "stop"', async () => {
    const { service, users, api } = build();

    await service.handle(job({ text: 'stop' }));

    expect(users.setBlocked).toHaveBeenCalledWith('user-1', true);
    expect(sent(api)).toContain('will not receive further messages');
  });

  it('clears the conversation and the retained context on the way out', async () => {
    const { service, conversations, memory } = build();

    await service.handle(job({ text: 'unsubscribe' }));

    expect(memory.clear).toHaveBeenCalledWith('user-1');
    expect(conversations.clear).toHaveBeenCalledWith('user-1');
  });

  it('says goodbye before blocking, so the goodbye is not the first thing refused', async () => {
    const { service, api, users } = build();

    await service.handle(job({ text: 'stop' }));

    const sendOrder = api.sendText.mock.invocationCallOrder[0];
    const blockOrder = users.setBlocked.mock.invocationCallOrder[0];
    expect(sendOrder).toBeLessThan(blockOrder);
  });

  it('ignores an ordinary message from a blocked account', async () => {
    const { service, api } = build({ user: userRow({ is_blocked: true }) });

    await service.handle(job({ text: 'what is IPC 420' }));

    expect(api.sendText).not.toHaveBeenCalled();
  });

  it('lets "start" back in, which the goodbye promised and nothing implemented', async () => {
    const { service, api, users } = build({ user: userRow({ is_blocked: true }) });

    await service.handle(job({ text: 'start' }));

    expect(users.setBlocked).toHaveBeenCalledWith('user-1', false);
    expect(sent(api)).toContain('Welcome back');
  });

  it.each(['START', ' resume ', 'start!'])('accepts %p as the way back', async (text) => {
    const { service, users } = build({ user: userRow({ is_blocked: true }) });

    await service.handle(job({ text }));

    expect(users.setBlocked).toHaveBeenCalledWith('user-1', false);
  });
});

describe('flows started from the interactive menu', () => {
  it('records a bar council number instead of bouncing it to the menu', async () => {
    // The verify flow sets AWAITING_BAR_ID, which the router does not know -
    // so the enrolment number used to be answered with the help menu and never
    // reach submitBarCouncilId at all.
    const conversations = conversationStore();
    conversations.seed('AWAITING_BAR_ID');
    const { service, users } = build({ conversations });

    await service.handle(job({ text: 'D/1234/2015' }));

    expect(users.submitBarCouncilId).toHaveBeenCalledWith('user-1', 'D/1234/2015');
  });

  it('looks up a CNR sent after tapping "Case status"', async () => {
    const conversations = conversationStore();
    conversations.seed('AWAITING_CNR');
    const { service, ecourts } = build({ conversations });

    await service.handle(job({ text: 'BRMG030000191989' }));

    expect(ecourts.lookup).toHaveBeenCalledWith('BRMG030000191989');
  });

  it('charges for that lookup, so the menu is not the free door', async () => {
    // Typing a CNR costs a credit. Reaching the same lookup through the list
    // menu took none, which is one feature at two prices depending on how you
    // got there.
    const conversations = conversationStore();
    conversations.seed('AWAITING_CNR');
    const { service, credits } = build({ conversations });

    await service.handle(job({ text: 'BRMG030000191989' }));

    expect(credits.spend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CASE_STATUS', cost: 1 }),
    );
  });

  it('does not look the case up when the advocate cannot pay for it', async () => {
    const conversations = conversationStore();
    conversations.seed('AWAITING_CNR');
    const { service, ecourts, credits } = build({ conversations });
    credits.spend.mockResolvedValue({
      allowed: false,
      charged: 0,
      replay: false,
      balance: { free: 0, paid: 0, total: 0, monthlyAllowance: 30, unlimited: false },
    });

    await service.handle(job({ text: 'BRMG030000191989' }));

    expect(ecourts.lookup).not.toHaveBeenCalled();
  });

  it('releases the flow and answers when the advocate changes the subject', async () => {
    // Having asked for an enrolment number, replying "that is not valid" to
    // everything traps somebody in a state they did not know they were in.
    const conversations = conversationStore();
    conversations.seed('AWAITING_BAR_ID');
    const { service, users, api } = build({ conversations });

    await service.handle(job({ text: 'what is anticipatory bail' }));

    expect(users.submitBarCouncilId).not.toHaveBeenCalled();
    expect(api.sendText).toHaveBeenCalled();
  });
});

describe('paging through precedents', () => {
  it('keeps the result set so "more" has something to serve', async () => {
    const conversations = conversationStore();
    conversations.seed('PRECEDENT_SEARCH', {});
    const rows = Array.from({ length: 12 }, (_, i) => precedent(`j${i}`));
    const { service } = build({ conversations, precedents: rows });

    await service.handle(job({ text: 'anticipatory bail in NDPS cases' }));

    const stored = conversations.rows();
    expect(stored?.state).toBe('PRECEDENT_SEARCH');
    expect((stored?.context as { precedentRows?: unknown[] }).precedentRows).toHaveLength(12);
    expect((stored?.context as { precedentOffset?: number }).precedentOffset).toBe(5);
  });

  it('serves the second page rather than claiming there is none', async () => {
    // The regression, exactly: rows were written and then overwritten, so this
    // replied "that was the last result" while eleven judgments sat unread.
    const conversations = conversationStore();
    conversations.seed('PRECEDENT_SEARCH', {});
    const rows = Array.from({ length: 12 }, (_, i) => precedent(`j${i}`));
    const { service, api } = build({ conversations, precedents: rows });

    await service.handle(job({ text: 'anticipatory bail in NDPS cases' }));
    api.sendText.mockClear();
    await service.handle(job({ waMessageId: 'wamid.2', text: 'more' }));

    const page = sent(api);
    expect(page).not.toContain('That was the last result');
    expect(page).toContain('Showing 6–10 of 12');
  });

  it('stops offering more once the set is exhausted', async () => {
    const conversations = conversationStore();
    conversations.seed('PRECEDENT_SEARCH', {});
    const rows = Array.from({ length: 7 }, (_, i) => precedent(`j${i}`));
    const { service, api } = build({ conversations, precedents: rows });

    await service.handle(job({ text: 'anticipatory bail' }));
    await service.handle(job({ waMessageId: 'wamid.2', text: 'more' }));
    api.sendText.mockClear();
    await service.handle(job({ waMessageId: 'wamid.3', text: 'more' }));

    expect(sent(api)).toContain('That was the last result');
  });

  it('pages a search that was typed as a question, not picked from the menu', async () => {
    // The path an advocate actually takes: type "case law on X" at the menu, get
    // five results and a footer saying to reply "more". The answer leaves the
    // conversation at MAIN_MENU, where "more" was not read as a page request -
    // so it went to the classifier and came back "I only handle questions about
    // Indian law", with eleven judgments already retrieved and held.
    const conversations = conversationStore();
    conversations.seed('MAIN_MENU', {});
    const rows = Array.from({ length: 12 }, (_, i) => precedent(`j${i}`));
    const { service, api } = build({ conversations, precedents: rows, intent: 'PRECEDENT_SEARCH' });

    await service.handle(job({ text: 'case law on anticipatory bail in NDPS matters' }));
    api.sendText.mockClear();
    await service.handle(job({ waMessageId: 'wamid.2', text: 'more' }));

    const page = sent(api);
    expect(page).toContain('Showing 6–10 of 12');
    expect(page).not.toContain('I only handle questions about Indian law');
  });

  it('does not hold a set that fits on one page', async () => {
    const conversations = conversationStore();
    conversations.seed('PRECEDENT_SEARCH', {});
    const { service } = build({ conversations, precedents: [precedent('j1')] });

    await service.handle(job({ text: 'anticipatory bail' }));

    const context = conversations.rows()?.context as { precedentRows?: unknown[] };
    expect(context.precedentRows).toBeUndefined();
  });
});
