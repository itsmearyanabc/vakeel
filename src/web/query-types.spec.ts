import { CREDIT_COST } from '../credits/credits.service';
import { ChatMessageRow, PrecedentRow, UserRow } from '../database/types';
import { CnrNotFoundError } from '../ecourts/ecourts.service';
import { ChatEvent, ChatService } from './chat.service';

/**
 * Every kind of question, end to end, on the web side.
 *
 * The same coverage as the WhatsApp query-types spec, and it exists separately
 * for the reason the two services exist separately: they share the pipeline and
 * diverge above it, so a fix applied to one is not applied to the other. That
 * divergence has already produced two live bugs - a case status that charged on
 * one channel and not the other, and a case-law card rendered in two different
 * formats - and both were invisible until somebody used both surfaces.
 */

function precedent(id: string): PrecedentRow {
  return {
    judgment_id: id,
    case_title: 'Ram Kumar vs State of Bihar',
    neutral_citation: '2024 INSC 1',
    reporter_citations: ['AIR 2024 SC 9'],
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
    total_matches: 1,
  } as PrecedentRow;
}

const USER = { id: 'user-1', role: 'GUEST_LAWYER', preferred_language: 'en' } as UserRow;

function build(
  over: {
    intent?: string;
    cnr?: string | null;
    precedents?: PrecedentRow[];
    allowed?: boolean;
    lookup?: jest.Mock;
    corpusJudgments?: number;
  } = {},
) {
  const messages: ChatMessageRow[] = [];

  const chats = {
    findThread: jest.fn().mockResolvedValue({ id: 'thread-1', title: 'A thread' }),
    createThread: jest.fn().mockResolvedValue({ id: 'thread-1', title: 'New chat' }),
    autoTitle: jest.fn().mockResolvedValue(undefined),
    recentTurns: jest.fn().mockResolvedValue([]),
    appendMessage: jest.fn(async (input: Record<string, unknown>) => {
      const row = {
        id: `msg-${messages.length + 1}`,
        role: input.role,
        content: input.content,
        intent: input.intent ?? null,
        citations: input.citations ?? [],
        structured: input.structured ?? null,
        credits_charged: input.creditsCharged ?? 0,
        guardrail_flagged: false,
        error_detail: input.errorDetail ?? null,
        created_at: new Date(),
      } as unknown as ChatMessageRow;
      messages.push(row);
      return row;
    }),
  };

  const intents = {
    classify: jest.fn().mockResolvedValue({
      intent: over.intent ?? 'SECTION_LOOKUP',
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
      text: 'Section 302 IPC prescribes the punishment for murder.',
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
    answerSmallTalk: jest.fn().mockResolvedValue('Namaste. What can I help with?'),
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

  const balance = { free: 10, paid: 0, total: 10, monthlyAllowance: 30, unlimited: false };
  const credits = {
    spend: jest.fn().mockResolvedValue({
      allowed: over.allowed !== false,
      charged: over.allowed === false ? 0 : 2,
      replay: false,
      balance,
    }),
    peek: jest.fn().mockResolvedValue(balance),
    refund: jest.fn().mockResolvedValue(undefined),
  };

  const ecourts = {
    lookup: over.lookup ?? jest.fn().mockResolvedValue({ cnr: 'BRMG030000191989', mocked: false }),
  };
  const analytics = { recordSearch: jest.fn().mockResolvedValue(undefined) };
  const corpus = {
    countCorpus: jest.fn().mockResolvedValue({ judgments: over.corpusJudgments ?? 100 }),
  };
  const registry = { isFullyMocked: false };

  const service = new ChatService(
    chats as never,
    intents as never,
    rag as never,
    precedents as never,
    ecourts as never,
    credits as never,
    analytics as never,
    corpus as never,
    registry as never,
  );

  return { service, credits, ecourts, precedents, rag, chats, analytics };
}

/** Drain the generator, which is how the controller consumes it. */
async function ask(service: ChatService, question: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of service.ask({ user: USER, threadId: 'thread-1', question })) {
    events.push(event);
  }
  return events;
}

function answers(events: ChatEvent[]): string {
  return events
    .filter((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer')
    .map((e) => e.message.content)
    .join('\n');
}

function errors(events: ChatEvent[]): string {
  return events
    .filter((e): e is Extract<ChatEvent, { type: 'error' }> => e.type === 'error')
    .map((e) => `${e.code}: ${e.message}`)
    .join('\n');
}

function charged(credits: { spend: jest.Mock }): { action: string; cost: number } | null {
  const call = credits.spend.mock.calls[0]?.[0];
  return call ? { action: call.action, cost: call.cost } : null;
}

describe('small talk', () => {
  it('is answered without charging', async () => {
    const { service, credits } = build({ intent: 'SMALL_TALK' });

    const events = await ask(service, 'hi');

    expect(answers(events)).toContain('Namaste');
    expect(charged(credits)).toBeNull();
  });
});

describe('case status', () => {
  it('charges one credit, the same as the bot does', async () => {
    // The two channels charged differently for this once. They must not again.
    const { service, credits, ecourts } = build({ intent: 'CASE_STATUS', cnr: 'BRMG030000191989' });

    await ask(service, 'status of BRMG030000191989');

    expect(ecourts.lookup).toHaveBeenCalledWith('BRMG030000191989');
    expect(charged(credits)).toEqual({ action: 'CASE_STATUS', cost: CREDIT_COST.CASE_STATUS });
  });

  it('reports what it actually charged, not zero', async () => {
    const { service } = build({ intent: 'CASE_STATUS', cnr: 'BRMG030000191989' });

    const events = await ask(service, 'BRMG030000191989');
    const answer = events.find(
      (e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer',
    );

    expect(answer?.charged).toBe(2);
  });

  it('refunds and keeps the failure in the thread when the case is not found', async () => {
    // Recorded as a message rather than thrown, so the question and the reason
    // it failed stay together - which means the outer catch never sees it and
    // the refund has to happen on this path.
    const { service, credits } = build({
      intent: 'CASE_STATUS',
      cnr: 'BRMG030000191989',
      lookup: jest.fn().mockRejectedValue(new CnrNotFoundError('BRMG030000191989')),
    });

    const events = await ask(service, 'BRMG030000191989');

    expect(credits.refund).toHaveBeenCalled();
    expect(answers(events)).toContain('No case found');
  });
});

describe('section lookup', () => {
  it('charges the search rate and answers', async () => {
    const { service, credits } = build({ intent: 'SECTION_LOOKUP' });

    const events = await ask(service, 'what is IPC 302');

    expect(charged(credits)).toEqual({
      action: 'SECTION_LOOKUP',
      cost: CREDIT_COST.SECTION_LOOKUP,
    });
    expect(answers(events)).toContain('punishment for murder');
  });

  it('streams the stages the pipeline actually reached', async () => {
    // Progress that is real, not a timer - see RagStage. A client rendering
    // these is showing what is happening.
    const { service } = build({ intent: 'SECTION_LOOKUP' });

    const events = await ask(service, 'IPC 420');
    const stages = events.filter((e) => e.type === 'stage');

    expect(stages.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('thread');
  });
});

describe('case law', () => {
  it('charges the search rate and returns structured rows', async () => {
    const { service, credits } = build({
      intent: 'PRECEDENT_SEARCH',
      precedents: [precedent('j1')],
    });

    const events = await ask(service, 'case law on anticipatory bail');

    expect(charged(credits)).toEqual({
      action: 'PRECEDENT_SEARCH',
      cost: CREDIT_COST.PRECEDENT_SEARCH,
    });

    const answer = events.find(
      (e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer',
    );
    const structured = answer?.message.structured as { kind?: string; items?: unknown[] };
    expect(structured?.kind).toBe('precedents');
    expect(structured?.items).toHaveLength(1);
  });

  it('sends every field the output format requires', async () => {
    // The web card is rendered from this projection. If a field is missing
    // here, no amount of correct rendering puts it on screen.
    const { service } = build({ intent: 'PRECEDENT_SEARCH', precedents: [precedent('j1')] });

    const events = await ask(service, 'bail precedents');
    const answer = events.find(
      (e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer',
    );
    const item = (answer?.message.structured as { items: Record<string, unknown>[] }).items[0];

    for (const field of [
      'caseNo',
      'petitioner',
      'respondent',
      'date',
      'bench',
      'equivalentCitations',
      'legalPrinciple',
    ]) {
      expect(item).toHaveProperty(field);
    }
  });

  it('refunds a search that found nothing', async () => {
    // Credits buy authorities, and none arrived.
    const { service, credits } = build({ intent: 'PRECEDENT_SEARCH', precedents: [] });

    const events = await ask(service, 'something obscure');

    expect(credits.refund).toHaveBeenCalledWith(
      'user-1',
      'GUEST_LAWYER',
      expect.stringContaining('spend:web:'),
      expect.any(String),
    );
    expect(answers(events)).toContain('not been charged');
  });

  it('says the corpus is empty rather than blaming the question', async () => {
    // "No judgments found" on a deployment with nothing to search reads as
    // "your question was bad", and sends an advocate off rephrasing a query
    // that was never going to work.
    const { service } = build({
      intent: 'PRECEDENT_SEARCH',
      precedents: [],
      corpusJudgments: 0,
    });

    const events = await ask(service, 'bail');

    expect(answers(events)).toContain('No judgment database');
  });
});

describe('running out of credits', () => {
  it('refuses without doing the work, and says what it would have cost', async () => {
    const { service, rag, precedents } = build({ intent: 'SECTION_LOOKUP', allowed: false });

    const events = await ask(service, 'IPC 302');

    expect(errors(events)).toContain('INSUFFICIENT_CREDITS');
    expect(rag.answer).not.toHaveBeenCalled();
    expect(precedents.search).not.toHaveBeenCalled();
  });

  it('never promises the credits come back tomorrow', async () => {
    // The free allowance is granted once for the life of the account. Naming a
    // reset date has an advocate wait instead of buying more.
    const { service, credits } = build({ intent: 'SECTION_LOOKUP', allowed: false });
    credits.spend.mockResolvedValue({
      allowed: false,
      charged: 0,
      replay: false,
      balance: { free: 0, paid: 0, total: 0, monthlyAllowance: 30, unlimited: false },
    });

    const events = await ask(service, 'IPC 302');

    expect(errors(events)).not.toMatch(/tomorrow|reset|refill/i);
  });
});

describe('the charge is keyed to the stored message', () => {
  it('derives the reference from the message id, so a retry charges once', async () => {
    const { service, credits } = build({ intent: 'SECTION_LOOKUP' });

    await ask(service, 'IPC 302');

    expect(credits.spend).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'spend:web:msg-1' }),
    );
  });
});
