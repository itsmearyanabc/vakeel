import { CREDIT_COST } from '../credits/credits.service';
import { PrecedentRow, WhatsAppUserRow } from '../database/types';
import { CnrNotFoundError } from '../ecourts/ecourts.service';
import { CircuitOpenError } from '../common/circuit-breaker';
import { InboundMessageJob } from '../jobs/queue.constants';
import { ConversationService } from './conversation.service';

/**
 * Every kind of question, end to end, on the WhatsApp side.
 *
 * The unit tests around this cover the pieces - what an action costs, whether a
 * query is a repeat, how a card is formatted. What they cannot see is the thing
 * that actually went wrong repeatedly in this codebase: a branch that answers,
 * charges, and does the wrong one of those. A free greeting that spends two
 * credits and a paid search that spends none both pass every test written
 * against the parts.
 *
 * So each case drives a whole inbound message through and asserts on the two
 * observable outcomes together - what reached the handset, and what moved in
 * the wallet.
 */

function precedent(id: string): PrecedentRow {
  return {
    judgment_id: id,
    case_title: `Ram Kumar vs State ${id}`,
    neutral_citation: null,
    reporter_citations: [],
    court_name: 'Patna High Court',
    court_type: 'HIGH_COURT',
    judgment_date: new Date('2024-09-11'),
    bench: ['A Kumar'],
    bench_strength: 1,
    act_sections: [],
    headnote: null,
    ratio_decidendi: 'Bail is the rule and jail the exception.',
    disposition: null,
    source_url: null,
    best_excerpt: '',
    para_number: null,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 12,
  } as PrecedentRow;
}

function conversationStore() {
  let row: { state: string; context: Record<string, unknown> } | null = null;
  return {
    rows: () => row,
    seed: (state: string, context: Record<string, unknown> = {}) => {
      row = { state, context };
    },
    get: jest.fn(async () => row),
    set: jest.fn(async (_u: string, state: string, context: Record<string, unknown> = {}) => {
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
    intent?: string;
    cnr?: string | null;
    precedents?: PrecedentRow[];
    conversations?: ReturnType<typeof conversationStore>;
    lookup?: jest.Mock;
    allowed?: boolean;
    deliverable?: boolean;
    answerText?: string;
  } = {},
) {
  const conversations = over.conversations ?? conversationStore();
  const found = userRow();

  const api = {
    sendText: jest.fn().mockResolvedValue({ ok: over.deliverable !== false }),
    send: jest.fn().mockResolvedValue({ ok: true }),
    markAsRead: jest.fn().mockResolvedValue(undefined),
  };
  const users = {
    resolveFromPhone: jest.fn().mockResolvedValue(found),
    setLanguage: jest.fn().mockResolvedValue(undefined),
    setBlocked: jest.fn().mockResolvedValue(undefined),
    completeProfile: jest.fn().mockResolvedValue({ accepted: true, user: found }),
    submitBarCouncilId: jest.fn().mockResolvedValue({ accepted: true }),
  };
  const intents = {
    classify: jest.fn().mockResolvedValue({
      intent: over.intent ?? 'GENERAL_LEGAL',
      language: 'en',
      cnrNumber: over.cnr ?? null,
      sectionNumber: null,
      actCode: null,
      searchQuery: 'q',
      confidence: 0.9,
    }),
  };
  const rag = {
    answer: jest.fn().mockResolvedValue({
      text: over.answerText ?? 'Section 302 IPC prescribes the punishment for murder.',
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
    answerSmallTalk: jest.fn().mockResolvedValue('Namaste! How can I help?'),
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
  const ecourts = {
    lookup: over.lookup ?? jest.fn().mockResolvedValue({ cnr: 'BRMG030000191989', mocked: false }),
  };
  const balance = { free: 10, paid: 0, total: 10, monthlyAllowance: 30, unlimited: false };
  const credits = {
    balance: jest.fn().mockResolvedValue(balance),
    peek: jest.fn().mockResolvedValue(balance),
    creditLine: jest.fn().mockReturnValue('Credits: 10 left'),
    spend: jest.fn().mockResolvedValue({
      allowed: over.allowed !== false,
      charged: over.allowed === false ? 0 : 2,
      replay: false,
      balance,
    }),
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

  return { service, api, users, conversations, precedents, ecourts, credits, rag, analytics, memory };
}

function sent(api: { sendText: jest.Mock }): string {
  return api.sendText.mock.calls.map((c) => String(c[1])).join('\n---\n');
}

/** What the wallet was asked to charge, or null when it was never asked. */
function charged(credits: { spend: jest.Mock }): { action: string; cost: number } | null {
  const call = credits.spend.mock.calls[0]?.[0];
  return call ? { action: call.action, cost: call.cost } : null;
}

/** Every case starts from a live session, so the greeting path is not in the way. */
function atMenu() {
  const store = conversationStore();
  store.seed('MAIN_MENU', {});
  return store;
}

describe('small talk', () => {
  it('answers a greeting and charges nothing', async () => {
    // Greeting the bot must never consume a credit. This is the branch where
    // getting it wrong is least likely to be reported and most likely to be
    // resented.
    const { service, api, credits } = build({
      intent: 'SMALL_TALK',
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'hi' }));

    expect(sent(api)).toContain('Namaste');
    expect(charged(credits)).toBeNull();
  });

  it('falls back to a fixed greeting when the model fails, still free', async () => {
    const { service, api, credits, rag } = build({
      intent: 'SMALL_TALK',
      conversations: atMenu(),
    });
    rag.answerSmallTalk.mockRejectedValue(new Error('model down'));

    await service.handle(job({ text: 'hello' }));

    expect(sent(api)).toContain('Namaste');
    expect(charged(credits)).toBeNull();
  });

  it('remembers the exchange so a second greeting is not identical', async () => {
    const { service, memory } = build({ intent: 'SMALL_TALK', conversations: atMenu() });

    await service.handle(job({ text: 'hi' }));

    expect(memory.append).toHaveBeenCalled();
  });
});

describe('menu navigation and unsupported questions', () => {
  it('sends the menu without charging', async () => {
    const { service, api, credits } = build({
      intent: 'MENU_NAVIGATION',
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'what can you do' }));

    expect(api.send).toHaveBeenCalled();
    expect(charged(credits)).toBeNull();
  });

  it('turns away an off-topic question without charging', async () => {
    const { service, api, credits } = build({
      intent: 'UNSUPPORTED',
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'what is the weather in Patna' }));

    expect(sent(api)).toContain('only handle questions about Indian law');
    expect(charged(credits)).toBeNull();
  });
});

describe('case status', () => {
  it('charges one credit and returns the court record', async () => {
    const { service, api, credits, ecourts } = build({
      intent: 'CASE_STATUS',
      cnr: 'BRMG030000191989',
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'status of BRMG030000191989' }));

    expect(ecourts.lookup).toHaveBeenCalledWith('BRMG030000191989');
    expect(charged(credits)).toEqual({
      action: 'CASE_STATUS',
      cost: CREDIT_COST.CASE_STATUS,
    });
  });

  it('refunds when the case does not exist', async () => {
    // Arguable and deliberate: the advocate cannot tell "no such case" from a
    // wrong base URL, and charging for a typo is how one becomes a complaint.
    const { service, api, credits } = build({
      intent: 'CASE_STATUS',
      cnr: 'BRMG030000191989',
      conversations: atMenu(),
      lookup: jest.fn().mockRejectedValue(new CnrNotFoundError('BRMG030000191989')),
    });

    await service.handle(job({ text: 'BRMG030000191989 status' }));

    expect(credits.refund).toHaveBeenCalledWith(
      'user-1',
      'GUEST_LAWYER',
      'spend:wa:wamid.1',
      expect.any(String),
    );
    expect(sent(api)).toContain('could not find a case');
  });

  it('refunds when the court service is down', async () => {
    const { service, api, credits } = build({
      intent: 'CASE_STATUS',
      cnr: 'BRMG030000191989',
      conversations: atMenu(),
      lookup: jest.fn().mockRejectedValue(new CircuitOpenError('ecourts', 60_000)),
    });

    await service.handle(job({ text: 'BRMG030000191989' }));

    expect(credits.refund).toHaveBeenCalled();
    expect(sent(api)).toContain('not responding');
  });

  it('asks for a CNR rather than charging when the question named no case', async () => {
    const { service, api, credits } = build({
      intent: 'CASE_STATUS',
      cnr: null,
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'what is the status of my case' }));

    expect(charged(credits)).toBeNull();
    expect(sent(api)).toContain('16-character CNR');
  });
});

describe('section lookup and general legal questions', () => {
  it.each(['SECTION_LOOKUP', 'GENERAL_LEGAL', 'DRAFTING_HELP'])(
    'charges the search rate for %s and answers from retrieval',
    async (intent) => {
      const { service, api, credits } = build({ intent, conversations: atMenu() });

      await service.handle(job({ text: 'what is IPC 302' }));

      expect(charged(credits)).toEqual({
        action: 'SECTION_LOOKUP',
        cost: CREDIT_COST.SECTION_LOOKUP,
      });
      expect(sent(api)).toContain('punishment for murder');
    },
  );

  it('always closes with the caveat and the way back', async () => {
    // A product commitment: an advocate must never receive an answer without
    // being told it is unverified.
    const { service, api } = build({ intent: 'SECTION_LOOKUP', conversations: atMenu() });

    await service.handle(job({ text: 'IPC 420' }));

    expect(sent(api)).toContain('Not legal advice');
    expect(sent(api)).toContain('Type *0*');
  });

  it('refunds when WhatsApp refuses to deliver the answer', async () => {
    // The model already ran, so the spend is real - but credits buy an answer,
    // and none arrived.
    const { service, credits } = build({
      intent: 'SECTION_LOOKUP',
      conversations: atMenu(),
      deliverable: false,
    });

    await service.handle(job({ text: 'IPC 420' }));

    expect(credits.refund).toHaveBeenCalledWith(
      'user-1',
      'GUEST_LAWYER',
      'spend:wa:wamid.1',
      expect.stringContaining('WhatsApp'),
    );
  });

  it('says so rather than sending an empty message when the model returns nothing', async () => {
    const { service, api } = build({
      intent: 'SECTION_LOOKUP',
      conversations: atMenu(),
      answerText: '   ',
    });

    await service.handle(job({ text: 'IPC 420' }));

    expect(sent(api)).toContain('could not produce an answer');
  });
});

describe('case law', () => {
  it('charges the search rate and returns the required card fields', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => precedent(`j${i}`));
    const { service, api, credits } = build({
      intent: 'PRECEDENT_SEARCH',
      precedents: rows,
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'case law on anticipatory bail' }));

    expect(charged(credits)).toEqual({
      action: 'PRECEDENT_SEARCH',
      cost: CREDIT_COST.PRECEDENT_SEARCH,
    });

    const page = sent(api);
    for (const label of [
      'CASE NO.',
      'PETITIONER',
      'RESPONDENT',
      'DATE OF JUDGMENT',
      'BENCH',
      'EQUIVALENT CITATIONS',
      'LEGAL PRINCIPLE',
    ]) {
      expect(page).toContain(`${label}:`);
    }
    expect(page).toContain('Not legal advice');
  });

  it('records the citations it returned, so the audit trail is not empty', async () => {
    const { service, analytics } = build({
      intent: 'PRECEDENT_SEARCH',
      precedents: [precedent('j1')],
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'bail precedents' }));

    expect(analytics.recordSearch).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'PRECEDENT_SEARCH', resultCount: 1 }),
    );
  });

  it('tells the advocate plainly when nothing matched', async () => {
    const { service, api } = build({
      intent: 'PRECEDENT_SEARCH',
      precedents: [],
      conversations: atMenu(),
    });

    await service.handle(job({ text: 'case law on something obscure' }));

    expect(sent(api)).toContain('No precedents found');
  });
});

describe('running out of credits', () => {
  it.each([
    ['SECTION_LOOKUP', 'what is IPC 302'],
    ['PRECEDENT_SEARCH', 'case law on bail'],
    ['CASE_STATUS', 'BRMG030000191989'],
  ])('refuses a %s and explains, without doing the work', async (intent, text) => {
    const { service, api, precedents, ecourts, rag } = build({
      intent,
      cnr: intent === 'CASE_STATUS' ? 'BRMG030000191989' : null,
      conversations: atMenu(),
      allowed: false,
    });

    await service.handle(job({ text }));

    // The refusal is the whole point: nothing downstream may run, or the
    // deployment pays for work it did not charge for.
    expect(precedents.search).not.toHaveBeenCalled();
    expect(ecourts.lookup).not.toHaveBeenCalled();
    expect(rag.answer).not.toHaveBeenCalled();
    expect(sent(api)).toMatch(/credit/i);
  });
});

describe('the charge is keyed to the message, not the attempt', () => {
  it('uses Metas message id, so a redelivered webhook charges once', async () => {
    const { service, credits } = build({ intent: 'SECTION_LOOKUP', conversations: atMenu() });

    await service.handle(job({ waMessageId: 'wamid.ABC', text: 'IPC 420' }));

    expect(credits.spend).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'spend:wa:wamid.ABC' }),
    );
  });
});
