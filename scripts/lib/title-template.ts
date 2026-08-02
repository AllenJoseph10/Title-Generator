// Pure, deterministic derivation of a `title_template` from a verbatim
// burned-in title: a bare cardinal number that quantifies a countable
// "content noun" (outfits, ways, tips, ...) is replaced with the
// placeholder `{N}`. Every other number in the corpus — durations, prices,
// decimals/ratings, years, ranks, percentages, product specs, ages,
// frequencies, numbers embedded in a proper noun — is left untouched. See
// title-template.test.ts for the corpus of examples this was designed
// against.
//
// Deliberately conservative: a missed quantity just means the title still
// sits in the corpus verbatim with no template, which is harmless — the
// title itself is always the source of truth. A wrongly templated
// non-quantity would corrupt the corpus's retrieval signal (a price or a
// year silently turned into "{N}" reads as a listicle count). We bias hard
// toward under-matching: every rule below only ever narrows the match, it
// never widens it.
//
// Number-word forms ("Six Old Money Outfits") are deliberately NOT
// handled. Parsing English number words correctly (twenty-one, a dozen,
// "one of the") is a much bigger surface area for false positives than it
// is worth for a handful of rows, and every burned-in title in the corpus
// is OCR'd verbatim, so the numeral form is overwhelmingly what's on
// screen. If number-word titles turn out to be common, a follow-up pass
// could add a small closed vocabulary (one..twenty) — the corpus doesn't
// need it today.

// Content nouns the title can promise to "deliver N of". These are the
// plural forms as they actually appear in the corpus; each also gets its
// naive singular below, so "1 mistake every guy makes" templates too, not
// just the plural case.
const CONTENT_NOUNS_PLURAL = [
  'outfits', 'ways', 'things', 'rules', 'tips', 'steps', 'reasons',
  'mistakes', 'looks', 'items', 'pieces', 'essentials', 'habits',
  'lessons', 'signs', 'types', 'styles', 'fits',
];

const CONTENT_NOUNS = new Set<string>();
for (const plural of CONTENT_NOUNS_PLURAL) {
  CONTENT_NOUNS.add(plural);
  CONTENT_NOUNS.add(plural.endsWith('s') ? plural.slice(0, -1) : plural);
}

// A word immediately before the number that marks it as a rank/position
// rather than a quantity: "Number 1 tourist mistake" is the #1 entry in
// the tourist-mistake genre, not a promise of one mistake shown — even
// though "mistake" is itself in the content-noun whitelist above.
const RANK_WORDS = new Set(['number', 'no', 'rank']);

// How many words after the number we scan for a content noun. "6 Old
// Money Outfits" has two words between the number and the noun it
// quantifies ("Old", "Money"); 4 gives comfortable margin without
// wandering into the next clause.
const FORWARD_WORD_WINDOW = 4;

// A comma-grouped integer like "1,500", OR a bare integer — captured as ONE
// token each, in that priority order. Splitting a genuine thousands-grouped
// price apart is exactly the failure mode this rule exists to avoid: "£1,500"
// must not fragment into two independent number matches ("1" and "500")
// where "500" could land next to an unrelated content noun.
//
// Decimals, fractions, ratios, and version-like sequences ("4.5", "3/5",
// "6.1.2") are deliberately NOT consumed as single tokens here — instead
// each digit run inside them still matches individually, and the
// punctuation-adjacency check below (isAdjacentToCompoundPunctuation)
// disqualifies every one of those runs. That is simpler and more general
// than trying to write a regex that swallows every compound-numeric shape
// up front, and it composes for free with the comma-grouped alternative:
// whichever alternative NUMBER_RE happens to match, the adjacency check
// still inspects the true characters immediately outside that match.
const NUMBER_RE = /\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g;

function stripPunct(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// 4-digit numbers in the 1900-2099 range are almost always years
// ("...in 2026"), never a quantity of content.
function isYearLike(digits: string): boolean {
  if (digits.length !== 4) return false;
  const n = Number(digits);
  return n >= 1900 && n <= 2099;
}

// A digit run that touches a "." or "/" with no space is a component of a
// larger compound numeric expression (a decimal "4.5", a leading-dot
// decimal ".5", a fraction/ratio "3/5", a version-like sequence "6.1.2")
// — never itself a count of discrete countable items. You cannot have 4.5
// outfits. Fix round 1 handled the "\d+\.\d+" shape as a single consumed
// token; that missed ".5" (no leading digit) and "3/5" or "4.5/5" (slash,
// or more than one separator). Checking raw adjacency here, per digit run,
// covers all of those uniformly and any further nesting ("6.1.2") for free
// — every digit run in a compound chain is adjacent to a "." or "/" on at
// least one side, so every one of them gets disqualified.
//
// The one direction this must NOT catch: a number followed by a genuine
// sentence-ending period, e.g. "You need 6. Outfits matter." — "6." here
// is followed by a space, not a digit, so it is a full stop, not a
// decimal point. That's why the forward check additionally requires a
// digit immediately after the ".", while every other direction disqualifies
// unconditionally on mere adjacency (a digit is never legitimately glued
// to "/" or "," outside of a compound expression or a proper thousands
// group, and the thousands-group case never reaches this check because
// NUMBER_RE already consumed it as one token above).
function isAdjacentToCompoundPunctuation(title: string, start: number, end: number): boolean {
  const charBefore = start > 0 ? title[start - 1] : '';
  const charsAfter = title.slice(end, end + 2);

  const precededByDotOrSlash = charBefore === '.' || charBefore === '/';
  // A digit run glued directly to a comma that ISN'T part of a proper
  // 3-digit thousands group (that shape was already consumed as one token
  // by NUMBER_RE) is most often a European-style comma-decimal ("4,5") or
  // similar — ambiguous in a listicle title, and this corpus is
  // English-language, so we resolve the ambiguity conservatively: treat it
  // as a compound expression and leave it unchanged rather than risk
  // mangling one half of it.
  const precededByComma = charBefore === ',';
  const followedBySlashOrComma = charsAfter[0] === '/' || charsAfter[0] === ',';
  const followedByDecimalPoint = charsAfter[0] === '.' && /\d/.test(charsAfter[1] ?? '');

  return precededByDotOrSlash || precededByComma || followedBySlashOrComma || followedByDecimalPoint;
}

// Is there a whitelisted content noun within FORWARD_WORD_WINDOW words
// after the number, in the same clause? We stop scanning at a sentence
// break, a newline, or the next digit — a content noun for THIS number
// has to be in the same breath, and a second number starts a new claim.
function hasContentNounAhead(title: string, afterIndex: number): boolean {
  const rest = title.slice(afterIndex);
  const stopMatch = rest.match(/[\n\r.!?:;]|\d/);
  const clause = stopMatch ? rest.slice(0, stopMatch.index) : rest;

  const words = clause.split(/\s+/).filter(Boolean).slice(0, FORWARD_WORD_WINDOW);
  for (const w of words) {
    if (CONTENT_NOUNS.has(stripPunct(w).toLowerCase())) return true;
  }
  return false;
}

export function templatiseTitle(title: string): string {
  let result = '';
  let cursor = 0;
  NUMBER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = NUMBER_RE.exec(title)) !== null) {
    const digits = match[0].replace(/,/g, '');
    const start = match.index;
    const end = start + match[0].length;

    // Compound numeric expression: "4.5", ".5", "3/5", "4.5/5", "6.1.2" —
    // see isAdjacentToCompoundPunctuation() above.
    const isCompound = isAdjacentToCompoundPunctuation(title, start, end);

    // Price: "£1,500", "$50", "€9" — a number glued to a currency symbol
    // is never a content quantity.
    const charBefore = start > 0 ? title[start - 1] : '';
    const precededByCurrency = /[$£€¥]/.test(charBefore);

    // Spec/measurement: "50+" (SPF), percentage: "96%".
    const charsAfter = title.slice(end, end + 2);
    const followedByPercentOrPlus = /^[%+]/.test(charsAfter);

    // Age/decade: "30's".
    const followedByPossessive = /^'s/i.test(charsAfter);

    // Year: "in 2026".
    const yearLike = isYearLike(digits);

    // Rank: "Number 1 tourist mistake", "#1 mistake".
    const before = title.slice(0, start);
    const precedingWordMatch = before.match(/(\S+)\s*$/);
    const precedingWordRaw = precedingWordMatch ? precedingWordMatch[1] : '';
    const precededByRankWord =
      RANK_WORDS.has(stripPunct(precedingWordRaw).toLowerCase()) ||
      precedingWordRaw.startsWith('#');

    const disqualified =
      isCompound ||
      precededByCurrency ||
      followedByPercentOrPlus ||
      followedByPossessive ||
      yearLike ||
      precededByRankWord;

    if (!disqualified && hasContentNounAhead(title, end)) {
      result += title.slice(cursor, start) + '{N}';
      cursor = end;
    }
  }

  result += title.slice(cursor);
  return result;
}
