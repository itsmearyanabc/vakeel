/**
 * The privacy policy and the data-deletion instructions.
 *
 * ## Why this page exists in code rather than in a CMS
 *
 * Meta will not publish an app without a reachable Privacy Policy URL, and an
 * unpublished app receives no production webhooks at all - so this page is a
 * hard dependency of the bot working, not a formality to be added later.
 *
 * ## Why the specifics are derived, not asserted
 *
 * Every retention period below is the default argument of `purge_expired_data()`
 * in migration 0005, and every processor named is one this codebase actually
 * calls. A policy that describes a system nobody implemented is worse than no
 * policy: it is a published, dated claim that happens to be false, and under the
 * DPDP Act it is the claim rather than the intention that is enforceable.
 *
 * If those periods change in the migration, they must change here in the same
 * commit. That coupling is deliberate and there is no clever way around it.
 *
 * NOT LEGAL ADVICE. This is a truthful description of what the software does,
 * written so counsel has something accurate to review rather than a template to
 * rewrite from scratch.
 */

export interface LegalView {
  /** Where this deployment lives, for the contact and scope sections. */
  publicUrl: string;
  /** Shown as the operator. Empty renders a placeholder the operator must fill. */
  operator: string;
  /** Contact address for data requests. */
  contactEmail: string;
  year: number;
  updated: string;
}

const esc = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function shell(title: string, view: LegalView, body: string, css: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} — Vakeel Saathi</title>
<meta name="description" content="How Vakeel Saathi handles advocates' personal data.">
<style>${css}
.legal { max-width: 760px; margin: 0 auto; padding: 56px 22px 96px; }
.legal h1 { font-size: 34px; letter-spacing: -.03em; margin: 0 0 8px; }
.legal .meta { color: var(--muted); font-size: 14px; margin: 0 0 40px; }
.legal h2 { font-size: 19px; letter-spacing: -.02em; margin: 40px 0 10px; }
.legal h3 { font-size: 15px; margin: 24px 0 6px; }
.legal p, .legal li { color: var(--ink-2); line-height: 1.65; font-size: 15px; }
.legal ul { padding-left: 20px; }
.legal li { margin-bottom: 7px; }
.legal table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
.legal th, .legal td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); }
.legal th { color: var(--muted); font-weight: 600; font-size: 12px;
            text-transform: uppercase; letter-spacing: .06em; }
.legal .back { display: inline-block; margin-bottom: 28px; color: var(--muted);
               text-decoration: none; font-size: 14px; }
.legal .back:hover { color: var(--ink); }
.legal .note { border: 1px solid var(--line); border-radius: var(--r);
               padding: 14px 16px; margin: 24px 0; background: var(--panel); }
</style>
</head>
<body>
<main class="legal">
  <a class="back" href="/">&larr; Vakeel Saathi</a>
  ${body}
</main>
</body>
</html>`;
}

/**
 * The privacy policy.
 *
 * Written in the second person and in plain language on purpose. The readers
 * are advocates - they will notice evasion faster than most - and a policy
 * nobody finishes reading provides no consent worth relying on.
 */
export function renderPrivacy(view: LegalView, css: string): string {
  const operator = view.operator || 'the operator of Vakeel Saathi';
  const contact = view.contactEmail || 'the contact address published on this site';

  const body = `
  <h1>Privacy Policy</h1>
  <p class="meta">Last updated ${esc(view.updated)} · Applies to ${esc(view.publicUrl)} and the Vakeel Saathi WhatsApp service</p>

  <p>Vakeel Saathi is a legal research assistant for advocates practising in India.
  This page describes what personal data the service collects, why, who it is shared
  with, and how long it is kept. It is written to match what the software actually
  does.</p>

  <h2>1. Who is responsible</h2>
  <p>${esc(operator)} is the Data Fiduciary for the purposes of the Digital Personal
  Data Protection Act, 2023. Questions and requests under this policy go to
  ${esc(contact)}.</p>

  <h2>2. What is collected</h2>

  <h3>When you create an account</h3>
  <ul>
    <li><b>Your name</b>, as you enter it.</li>
    <li><b>Your email address</b>, used to identify your account.</li>
    <li><b>Your WhatsApp number</b>, which is required and is verified by a one-time
        code sent to it. The number is not stored until that code is confirmed.</li>
    <li><b>A password</b>, stored only as an Argon2 hash. The password itself is never
        stored and cannot be recovered from what is stored - if you forget it, it is
        replaced, not retrieved.</li>
  </ul>

  <h3>If you choose to verify as an advocate</h3>
  <ul>
    <li><b>Your Bar Council enrolment number and state.</b> The enrolment number is
        encrypted at rest. A separate keyed hash of it is stored so that the same
        enrolment cannot be registered twice; that hash cannot be reversed to recover
        the number.</li>
  </ul>

  <h3>When you use the service</h3>
  <ul>
    <li><b>Your questions and the answers given</b>, so that a conversation has
        continuity and you can return to earlier research.</li>
    <li><b>WhatsApp messages exchanged with the bot</b>, including delivery status.</li>
    <li><b>Usage records</b> - which searches were run and how many credits they cost.</li>
  </ul>

  <p>The service does not collect your contacts, your location, your device
  identifiers, or anything from other apps. There is no advertising and no
  third-party analytics or tracking script on this site.</p>

  <h2>3. Why</h2>
  <ul>
    <li><b>To provide the service</b> - answering legal research questions is the
        purpose you signed up for.</li>
    <li><b>To verify your number</b>, which is how one account is kept distinct from
        another across the website and WhatsApp.</li>
    <li><b>To operate credits and billing</b>, where you have purchased credits.</li>
    <li><b>To keep the service secure</b> - detecting abuse, rate-limiting sign-in
        attempts, and preventing one account from being used to reach another's data.</li>
  </ul>
  <p>Your questions are not used to train any machine-learning model.</p>

  <h2>4. Who your data reaches</h2>
  <p>The service is built on third parties who process data on its behalf. Each one
  receives only what it needs to do its job.</p>
  <table>
    <thead><tr><th>Processor</th><th>What it receives</th><th>Why</th></tr></thead>
    <tbody>
      <tr><td>Supabase (PostgreSQL)</td><td>All stored account and conversation data</td><td>Database hosting</td></tr>
      <tr><td>Meta / WhatsApp</td><td>Your number and message content</td><td>Delivering the WhatsApp conversation</td></tr>
      <tr><td>OpenAI</td><td>The text of your question and retrieved legal source material</td><td>Composing the answer</td></tr>
      <tr><td>Indian Kanoon</td><td>Your search terms</td><td>Retrieving judgments</td></tr>
      <tr><td>eCourts data provider</td><td>The CNR number you ask about</td><td>Case status lookups</td></tr>
      <tr><td>Razorpay</td><td>Payment details, handled by them and not stored here</td><td>Buying credits</td></tr>
    </tbody>
  </table>
  <p>Your data is not sold, rented, or shared with anyone for their own purposes. It
  is disclosed otherwise only where the law requires it.</p>

  <div class="note">
    <p style="margin:0"><b>Where your data is stored.</b> The database is hosted in the
    Asia Pacific (Sydney) region, and the AI and case-law providers above process data
    outside India. By using the service you accept that your data is transferred and
    stored outside India for these purposes.</p>
  </div>

  <h2>5. How long it is kept</h2>
  <p>A sweep runs automatically every night at 03:00 IST and deletes the following:</p>
  <table>
    <thead><tr><th>Data</th><th>Kept for</th></tr></thead>
    <tbody>
      <tr><td>Search history</td><td>180 days</td></tr>
      <tr><td>WhatsApp message log</td><td>90 days</td></tr>
      <tr><td>Webhook delivery records</td><td>7 days</td></tr>
      <tr><td>Expired sign-in sessions and one-time codes</td><td>2 days after expiry</td></tr>
    </tbody>
  </table>
  <p>Your account itself, and the credit ledger, are kept until you ask for deletion.
  The ledger is retained while the account exists because it is the record of what you
  paid for and what you spent.</p>

  <h2>6. Your rights</h2>
  <p>Under the DPDP Act, 2023 you may ask to <b>access</b> the personal data held about
  you, <b>correct</b> anything inaccurate, <b>withdraw consent</b>, <b>erase</b> your
  data, and <b>nominate</b> someone to exercise these rights if you are unable to.
  Write to ${esc(contact)} and you will get a response within 30 days.</p>

  <h2 id="delete">7. Deleting your data</h2>
  <p>To delete your account and the personal data associated with it, email
  ${esc(contact)} from the address on the account, or send <b>DELETE MY DATA</b> to the
  bot from your registered WhatsApp number.</p>
  <p>Your account, profile, chat history, search history and message log are then
  erased within 30 days. Records that must be kept for a legal or tax obligation - a
  payment receipt, for instance - are retained only for as long as that obligation
  lasts, and are not used for anything else.</p>

  <h2>8. Security</h2>
  <ul>
    <li>Passwords are stored as Argon2 hashes and are never recoverable.</li>
    <li>Bar Council enrolment numbers are encrypted at rest.</li>
    <li>Sign-in sessions are held in cookies that page scripts cannot read.</li>
    <li>Every WhatsApp webhook is signature-verified before it is acted on.</li>
    <li>Traffic to this site is served over HTTPS only.</li>
  </ul>
  <p>No system is perfectly secure. If a breach affects your personal data, you and the
  Data Protection Board of India will be notified as the DPDP Act requires.</p>

  <h2>9. Children</h2>
  <p>The service is for practising advocates and is not directed at anyone under 18.
  Accounts are not knowingly created for children.</p>

  <h2>10. Accuracy of answers</h2>
  <p>Vakeel Saathi is a research aid, not legal advice, and does not create an
  advocate-client relationship. Citations are checked against the database before they
  are shown, but you remain responsible for verifying any authority before relying on
  it in practice.</p>

  <h2>11. Changes</h2>
  <p>If this policy changes materially, the date at the top changes and you will be
  told through the service before the change takes effect.</p>

  <p class="meta" style="margin-top:48px">&copy; ${view.year} Vakeel Saathi</p>`;

  return shell('Privacy Policy', view, body, css);
}
