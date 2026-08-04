/**
 * Row shapes returned by the repositories.
 *
 * These mirror the SQL in supabase/migrations. postgres.js does not generate
 * types, so this file is the contract - if you change a migration, change the
 * matching interface here.
 */

export type VerificationStatus = 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

export type UserRole = 'GUEST_LAWYER' | 'VERIFIED_ADVOCATE' | 'LEGAL_AUDITOR' | 'SUPER_ADMIN';

export type QueryIntent =
  | 'CASE_STATUS'
  | 'SECTION_LOOKUP'
  | 'PRECEDENT_SEARCH'
  | 'DRAFTING_HELP'
  | 'GENERAL_LEGAL'
  | 'SMALL_TALK'
  | 'MENU_NAVIGATION'
  | 'UNSUPPORTED';

export type MessageDirection = 'INBOUND' | 'OUTBOUND';

export type MessageStatus = 'RECEIVED' | 'QUEUED' | 'PROCESSING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface UserRow {
  id: string;
  phone_number: string;
  full_name: string | null;
  bar_council_id_enc: string | null;
  bar_council_id_hash: string | null;
  bar_council_state: string | null;
  verification_status: VerificationStatus;
  role: UserRole;
  preferred_language: string;
  id_card_storage_path: string | null;
  verification_notes: string | null;
  verified_at: Date | null;
  is_blocked: boolean;
  opted_out_at: Date | null;
  last_active_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationStateRow {
  user_id: string;
  state: string;
  context: Record<string, unknown>;
  expires_at: Date | null;
  updated_at: Date;
}

export interface StatuteRow {
  id: string;
  act_code: string;
  act_name: string;
  section_number: string;
  section_title: string;
  section_text: string;
  punishment: string | null;
  is_cognizable: boolean | null;
  is_bailable: boolean | null;
  is_compoundable: boolean | null;
  triable_by: string | null;
  corresponding_act: string | null;
  corresponding_section: string | null;
  match_type: 'EXACT' | 'FULLTEXT' | 'FUZZY';
  score: number;
}

/** A retrieved passage, as returned by hybrid_search_judgments(). */
export interface RetrievedChunk {
  chunk_id: string;
  judgment_id: string;
  content: string;
  para_number: number | null;
  case_title: string;
  neutral_citation: string | null;
  reporter_citations: string[];
  court_name: string | null;
  judgment_date: Date | null;
  ratio_decidendi: string | null;
  dense_rank: number | null;
  sparse_rank: number | null;
  score: number;
}

export interface CitationCheck {
  citation: string;
  exists: boolean;
  judgment_id: string | null;
  case_title: string | null;
}

export interface StatuteRefCheck {
  ref: string;
  exists: boolean;
  act_code: string | null;
  section_number: string | null;
  section_title: string | null;
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  quota: number;
}

export interface SearchHistoryInput {
  userId: string;
  queryText: string;
  detectedLanguage: string;
  resolvedQuery?: string | null;
  intent: QueryIntent;
  citations: string[];
  resultCount: number;
  modelUsed?: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  guardrailFlagged: boolean;
  guardrailReason?: string | null;
}
