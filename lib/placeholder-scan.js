const {
  WHOLE_SCALAR,
  WHOLE_PLACEHOLDER,
  PLACEHOLDER_IN_TEXT,
  PLACEHOLDER_POSITIONS,
} = require('./reference-positions');

function groupSpans(match, offset) {
  const spans = [];
  for (const [group, span] of Object.entries((match.indices && match.indices.groups) || {})) {
    if (span) spans.push({ group, start: offset + span[0], end: offset + span[1] });
  }
  return spans;
}

function matchWholeReferences(text, rules, offset = 0) {
  const source = String(text);
  const found = [];
  for (const rule of rules) {
    const match = source.match(new RegExp(rule.pattern, 'd'));
    if (!match || match.index !== 0 || match[0].length === 0) continue;
    found.push({
      rule,
      groups: match.groups || {},
      trailingText: source.slice(match[0].length),
      span: { start: offset, end: offset + match[0].length, groups: groupSpans(match, offset) },
    });
  }
  return found;
}

function matchWholeReference(text, rules, offset = 0) {
  return matchWholeReferences(text, rules, offset)[0] || null;
}

function readsAt(reading, position) {
  return reading.rule.positions.includes(position)
    && (reading.rule.textAfterNameAllowed || reading.trailingText === '');
}

function placeholderBodyRules(rules) {
  return (rules || []).filter((rule) => rule.positions.some((position) => PLACEHOLDER_POSITIONS.includes(position)));
}

function scanPlaceholders(text, placeholders, rules, offset = 0) {
  if (!placeholders) return [];
  const source = String(text);
  const bodyRules = placeholderBodyRules(rules);
  const otherRules = (rules || []).filter((rule) => !bodyRules.includes(rule) && rule.positions.includes(WHOLE_SCALAR));
  const found = [];
  for (const match of source.matchAll(new RegExp(placeholders.pattern, 'gd'))) {
    if (match[0].length === 0) continue;
    const bodySpan = match.indices.groups && match.indices.groups.body;
    if (!bodySpan) continue;
    const position = match[0] === source.trim() ? WHOLE_PLACEHOLDER : PLACEHOLDER_IN_TEXT;
    const placeholder = {
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      bodyStart: offset + bodySpan[0],
      bodyEnd: offset + bodySpan[1],
      text: match[0],
      body: match.groups.body,
      position,
    };
    const bodyReadings = matchWholeReferences(placeholder.body, bodyRules, placeholder.bodyStart);
    const readings = bodyReadings.filter((reading) => readsAt(reading, position));
    const reference = readings[0]
      || bodyReadings[0]
      || matchWholeReference(placeholder.body, otherRules, placeholder.bodyStart);
    found.push({ ...placeholder, reference: reference || null, readings });
  }
  return found;
}

module.exports = {
  matchWholeReference,
  matchWholeReferences,
  readsAt,
  placeholderBodyRules,
  scanPlaceholders,
};
