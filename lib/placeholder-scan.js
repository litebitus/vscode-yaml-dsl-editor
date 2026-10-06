const PLACEHOLDER_REFERENCES = ['local', 'ref'];
const CONCEPT_KINDS = { local: 'local', ref: 'resource' };

function groupSpans(match, offset) {
  const spans = [];
  for (const [group, span] of Object.entries((match.indices && match.indices.groups) || {})) {
    if (span) spans.push({ group, start: offset + span[0], end: offset + span[1] });
  }
  return spans;
}

function matchWholeReference(text, rules, offset = 0) {
  for (const rule of rules) {
    if (rule.where !== 'whole') continue;
    const match = String(text).match(new RegExp(rule.pattern, 'd'));
    if (!match || match.index !== 0 || match[0].length === 0) continue;
    return {
      rule,
      groups: match.groups || {},
      span: { start: offset, end: offset + match[0].length, groups: groupSpans(match, offset) },
    };
  }
  return null;
}

function placeholderBodyRules(placeholders, rules) {
  const kinds = placeholders.references.map((concept) => CONCEPT_KINDS[concept]);
  return (rules || []).filter((rule) => rule.where === 'whole' && kinds.includes(rule.target.kind));
}

function scanPlaceholders(text, placeholders, rules, offset = 0) {
  if (!placeholders) return [];
  const bodyRules = placeholderBodyRules(placeholders, rules);
  const found = [];
  for (const match of String(text).matchAll(new RegExp(placeholders.pattern, 'gd'))) {
    if (match[0].length === 0) continue;
    const bodySpan = match.indices.groups && match.indices.groups.body;
    if (!bodySpan) continue;
    const body = match.groups.body;
    const placeholder = {
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      bodyStart: offset + bodySpan[0],
      bodyEnd: offset + bodySpan[1],
      text: match[0],
      body,
    };
    if (placeholders.builtins.includes(body)) {
      found.push({ ...placeholder, kind: 'builtin' });
      continue;
    }
    const reference = matchWholeReference(body, bodyRules, placeholder.bodyStart);
    found.push(reference ? { ...placeholder, kind: 'reference', reference } : { ...placeholder, kind: 'invalid' });
  }
  return found;
}

module.exports = {
  PLACEHOLDER_REFERENCES,
  CONCEPT_KINDS,
  matchWholeReference,
  placeholderBodyRules,
  scanPlaceholders,
};
