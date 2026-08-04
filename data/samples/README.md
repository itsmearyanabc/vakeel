# Sample corpus

`judgments.sample.jsonl` contains **three fictional judgments**. They exist so
you can run the ingestion → chunking → embedding → retrieval → guardrail
pipeline end to end before you have a real corpus.

Every field is deliberately, visibly fake:

- Court is `SAMPLE COURT (NOT A REAL COURT)`
- Parties are "Sample Petitioner", "Illustrative Respondent"
- Citations use a `2024 SAMPLE n` series that does not exist
- Every paragraph is prefixed or suffixed with `SAMPLE DOCUMENT - NOT A REAL JUDGMENT`

This is not decoration. The citation guardrail verifies generated citations
**against whatever is in the corpus** — so anything you ingest becomes
citable. Loading realistic-looking fake judgments would teach the guardrail to
approve fabricated authority, which defeats the entire safety mechanism.

**Delete the sample data before serving real users:**

```sql
DELETE FROM judgments WHERE court_name = 'SAMPLE COURT (NOT A REAL COURT)';
```

Chunks are removed automatically by the foreign key cascade.

## Ingesting real judgments

Same JSONL shape, one object per line. Only `case_title` and `full_text` are
required:

```json
{
  "case_title": "State of Maharashtra v. Example",
  "court_name": "Supreme Court of India",
  "court_type": "SUPREME_COURT",
  "neutral_citation": "2024 INSC 452",
  "reporter_citations": ["AIR 2024 SC 1234", "(2024) 5 SCC 1"],
  "judgment_date": "2024-05-12",
  "bench": ["Chandrachud CJ", "Narasimha J"],
  "bench_strength": 2,
  "act_sections": ["IPC 302", "CRPC 439"],
  "keywords": ["bail", "murder"],
  "headnote": "...",
  "ratio_decidendi": "...",
  "disposition": "ALLOWED",
  "full_text": "...",
  "source_url": "https://..."
}
```

Populate `neutral_citation` and `reporter_citations` carefully — they are what
`verify_citations()` matches against, so a judgment ingested without them can
never be cited by the bot even when it is retrieved.

Sources worth looking at for bulk Indian judgment text: the Supreme Court's
eSCR portal, individual High Court judgment sites, and the India Code portal
for bare acts.
