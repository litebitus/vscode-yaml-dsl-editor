const PLACEHOLDER_POSITIONS = ['placeholder', 'placeholder_in_string'];

function groupSpans(match, offset) {
  const spans = [];
  for (const [group, span] of Object.entries((match.indices && match.indices.groups) || {})) {
    if (span) spans.push({ group, start: offset + span[0], end: offset + span[1] });
  }
  return spans;
}

function matchWholeReference(text, rules, offset = 0) {
  const source = String(text);
  for (const rule of rules) {
    const match = source.match(new RegExp(rule.pattern, 'd'));
    if (!match || match.index !== 0 || match[0].length === 0) continue;
    return {
      rule,
      groups: match.groups || {},
      trailingText: source.slice(match[0].length),
      span: { start: offset, end: offset + match[0].length, groups: groupSpans(match, offset) },
    };
  }
  return null;
}

function placeholderBodyRules(rules) {
  return (rules || []).filter((rule) => rule.where.some((position) => PLACEHOLDER_POSITIONS.includes(position)));
}

function scanPlaceholders(text, placeholders, rules, offset = 0) {
  if (!placeholders) return [];
  const source = String(text);
  const bodyRules = placeholderBodyRules(rules);
  const otherRules = (rules || []).filter((rule) => !bodyRules.includes(rule) && rule.where.includes('whole'));
  const found = [];
  for (const match of source.matchAll(new RegExp(placeholders.pattern, 'gd'))) {
    if (match[0].length === 0) continue;
    const bodySpan = match.indices.groups && match.indices.groups.body;
    if (!bodySpan) continue;
    const position = match[0] === source.trim() ? 'placeholder' : 'placeholder_in_string';
    const placeholder = {
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      bodyStart: offset + bodySpan[0],
      bodyEnd: offset + bodySpan[1],
      text: match[0],
      body: match.groups.body,
      position,
    };
    const reference = matchWholeReference(placeholder.body, bodyRules, placeholder.bodyStart)
      || matchWholeReference(placeholder.body, otherRules, placeholder.bodyStart);
    found.push(reference ? { ...placeholder, reference } : { ...placeholder, reference: null });
  }
  return found;
}

module.exports = {
  PLACEHOLDER_POSITIONS,
  matchWholeReference,
  placeholderBodyRules,
  scanPlaceholders,
};
