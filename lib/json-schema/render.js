const NODE_CONDITION_UNSTATED = 'a condition the schema states';
const ANY_SHAPE = 'any';
const CONSTRAINT_KEYWORDS = [
  'type',
  'enum',
  'const',
  'pattern',
  'format',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
];

function isSchemaObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codeSpan(text) {
  const fence = String(text).includes('`') ? '``' : '`';
  return `${fence}${text}${fence}`;
}

function jsonCode(value) {
  return codeSpan(JSON.stringify(value));
}

function keyList(keys) {
  const spans = keys.map(codeSpan);
  return spans.length > 1 ? `${spans.slice(0, -1).join(', ')} and ${spans[spans.length - 1]}` : spans.join('');
}

function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return Number.isInteger(value) ? 'integer' : typeof value;
}

function typeTextOf(keywords) {
  if (keywords.type !== undefined) return [].concat(keywords.type).join(' | ');
  if (keywords.const !== undefined) return jsonTypeOf(keywords.const);
  if (Array.isArray(keywords.enum)) return [...new Set(keywords.enum.map(jsonTypeOf))].join(' | ');
  return null;
}

function ownKeywordsOf(node) {
  return Object.fromEntries(CONSTRAINT_KEYWORDS
    .filter((keyword) => node[keyword] !== undefined)
    .map((keyword) => [keyword, node[keyword]]));
}

const COMMON_TAG_RENDERERS = [
  { keyword: 'enum', label: 'One of', render: (value) => value.map(jsonCode).join(', ') },
  { keyword: 'const', label: 'Value', render: jsonCode },
  { keyword: 'pattern', label: 'Pattern', render: codeSpan },
  { keyword: 'format', label: 'Format', render: codeSpan },
  { keyword: 'minimum', label: 'Minimum', render: jsonCode },
  { keyword: 'exclusiveMinimum', label: 'Above', render: jsonCode },
  { keyword: 'maximum', label: 'Maximum', render: jsonCode },
  { keyword: 'exclusiveMaximum', label: 'Below', render: jsonCode },
  { keyword: 'multipleOf', label: 'Multiple of', render: jsonCode },
  { keyword: 'minLength', label: 'Minimum length', render: jsonCode },
  { keyword: 'maxLength', label: 'Maximum length', render: jsonCode },
  { keyword: 'minItems', label: 'Minimum items', render: jsonCode },
  { keyword: 'maxItems', label: 'Maximum items', render: jsonCode },
  { keyword: 'uniqueItems', label: 'Unique items', render: (value) => (value === true ? 'yes' : null) },
  { keyword: 'minProperties', label: 'Minimum keys', render: jsonCode },
  { keyword: 'maxProperties', label: 'Maximum keys', render: jsonCode },
  {
    keyword: 'additionalProperties',
    label: 'Values',
    render: (value, helpers) => (isSchemaObject(value) ? helpers.knownShapeTextOf(value) : null),
  },
];

function createSchemaRenderer(draft, parser) {
  const tagRenderers = [...COMMON_TAG_RENDERERS, ...draft.tagRenderers];

  function referenceNameOf(reference) {
    return reference.slice(reference.lastIndexOf('/') + 1).replace(/^#/, '');
  }

  function formsOf(node, referencesFollowed) {
    if (node === false) return [{ name: 'nothing', keywords: {} }];
    if (!isSchemaObject(node)) return [{ name: null, keywords: {} }];
    const own = ownKeywordsOf(node);
    let forms = [{ name: null, keywords: own }];
    const reference = parser.referenceOf(node);
    if (reference !== null && !referencesFollowed.has(reference)) {
      const referred = formsOf(parser.resolveReference(reference), new Set([...referencesFollowed, reference]));
      const refinesReference = Object.keys(own).length > 0 || node.properties !== undefined;
      const singleName = refinesReference ? null : referenceNameOf(reference);
      forms = referred.map((form) => ({
        name: referred.length === 1 ? singleName : form.name,
        keywords: { ...form.keywords, ...own },
      }));
    }
    for (const part of draft.conjunctionListKeywords.flatMap((keyword) => node[keyword] || [])) {
      const partForms = formsOf(part, referencesFollowed);
      forms = forms.flatMap((form) => partForms.map((partForm) => ({
        name: form.name || partForm.name,
        keywords: { ...partForm.keywords, ...form.keywords },
      })));
    }
    const alternatives = draft.alternativeListKeywords.flatMap((keyword) => node[keyword] || []);
    if (alternatives.length > 0) {
      const alternativeForms = alternatives.flatMap((alternative) => formsOf(alternative, referencesFollowed));
      forms = forms.flatMap((form) => alternativeForms.map((alternativeForm) => ({
        name: alternativeForm.name,
        keywords: { ...form.keywords, ...alternativeForm.keywords },
      })));
    }
    const seen = new Set();
    return forms.filter((form) => {
      const formKey = JSON.stringify(form);
      if (seen.has(formKey)) return false;
      seen.add(formKey);
      return true;
    });
  }

  function displayNameOf(form) {
    return form.name || typeTextOf(form.keywords) || ANY_SHAPE;
  }

  function shapeOf(node) {
    return formsOf(node, new Set()).map(displayNameOf).join(' | ');
  }

  function shapeListOf(nodes) {
    return nodes.map((node) => codeSpan(shapeOf(node))).join(', ');
  }

  function knownShapeTextOf(node) {
    const shape = shapeOf(node);
    return shape === ANY_SHAPE ? null : codeSpan(shape);
  }

  function itemsTextOf(value) {
    return Array.isArray(value) ? `in order ${shapeListOf(value)}` : knownShapeTextOf(value);
  }

  function neededTextOf(needed, requiredSuffix) {
    if (Array.isArray(needed)) return `${keyList(needed)}${requiredSuffix}`;
    return consequenceTextOf(needed, requiredSuffix) || NODE_CONDITION_UNSTATED;
  }

  function neededKeysTextOf(neededByKey) {
    return Object.entries(neededByKey)
      .map(([key, needed]) => `${codeSpan(key)} needs ${neededTextOf(needed, '')}`)
      .join('; ');
  }

  const helpers = { shapeOf, shapeListOf, knownShapeTextOf, itemsTextOf, neededKeysTextOf, codeSpan };

  function tagsOf(keywords) {
    const tags = [];
    for (const { keyword, label, render } of tagRenderers) {
      if (keywords[keyword] === undefined) continue;
      const text = render(keywords[keyword], helpers, keywords);
      if (text) tags.push(`*${label}:* ${text}`);
    }
    return tags;
  }

  function acceptedFormLine(form) {
    const name = displayNameOf(form);
    const typeText = typeTextOf(form.keywords);
    const details = [typeText && typeText !== name ? typeText : null, ...tagsOf(form.keywords)].filter(Boolean);
    return `- ${codeSpan(name)}${details.length > 0 ? `: ${details.join(', ')}` : ''}`;
  }

  function sameInstancePartsOf(node, referencesFollowed) {
    if (!isSchemaObject(node)) return [];
    const parts = [node];
    for (const part of draft.conjunctionListKeywords.flatMap((keyword) => node[keyword] || [])) {
      parts.push(...sameInstancePartsOf(part, referencesFollowed));
    }
    const reference = parser.referenceOf(node);
    if (reference !== null && !referencesFollowed.has(reference)) {
      parts.push(...sameInstancePartsOf(
        parser.resolveReference(reference),
        new Set([...referencesFollowed, reference]),
      ));
    }
    return parts;
  }

  function conditionalsOf(node) {
    return sameInstancePartsOf(node, new Set()).filter((part) => part.if !== undefined);
  }

  function dependenciesOf(node, key) {
    return sameInstancePartsOf(node, new Set()).flatMap((part) => draft.dependencyMapKeywords
      .filter((keyword) => isSchemaObject(part[keyword]) && Object.hasOwn(part[keyword], key))
      .map((keyword) => part[keyword][key]));
  }

  function keyDependencyLinesOf(parentNode, key) {
    return dependenciesOf(parentNode, key).map((needed) => `*When set:* ${neededTextOf(needed, ' required')}.`);
  }

  function dependencyTextOf(parentNode, key) {
    const neededTexts = dependenciesOf(parentNode, key).map((needed) => neededTextOf(needed, ''));
    return neededTexts.length > 0 ? `${codeSpan(key)} needs ${neededTexts.join('; ')}` : null;
  }

  function conditionTextOf(ifNode) {
    if (!isSchemaObject(ifNode)) return null;
    const parts = [];
    for (const [key, keySchema] of Object.entries(ifNode.properties || {})) {
      if (!isSchemaObject(keySchema)) continue;
      if (keySchema.const !== undefined) parts.push(`${codeSpan(key)} is ${jsonCode(keySchema.const)}`);
      else if (Array.isArray(keySchema.enum)) {
        parts.push(`${codeSpan(key)} is one of ${keySchema.enum.map(jsonCode).join(', ')}`);
      }
    }
    if (Array.isArray(ifNode.required) && ifNode.required.length > 0) {
      parts.push(`${keyList(ifNode.required)} ${ifNode.required.length > 1 ? 'are' : 'is'} set`);
    }
    return parts.length > 0 ? parts.join(' and ') : null;
  }

  function consequenceTextOf(node, requiredSuffix = ' required') {
    if (!isSchemaObject(node)) return null;
    const parts = [];
    if (Array.isArray(node.required) && node.required.length > 0) {
      parts.push(`${keyList(node.required)}${requiredSuffix}`);
    }
    if (isSchemaObject(node.not) && Array.isArray(node.not.required) && node.not.required.length > 0) {
      parts.push(`${keyList(node.not.required)} must not be set`);
    }
    for (const part of draft.conjunctionListKeywords.flatMap((keyword) => node[keyword] || [])) {
      const partText = consequenceTextOf(part, requiredSuffix);
      if (partText) parts.push(partText);
    }
    const alternatives = draft.alternativeListKeywords.flatMap((keyword) => node[keyword] || []);
    const alternativeTexts = alternatives.map((alternative) => consequenceTextOf(alternative, requiredSuffix));
    if (alternatives.length > 0) {
      parts.push(alternativeTexts.map((text) => text || NODE_CONDITION_UNSTATED).join(', or '));
    }
    const reference = parser.referenceOf(node);
    if (parts.length === 0 && reference !== null) parts.push(`a ${codeSpan(referenceNameOf(reference))}`);
    return parts.length > 0 ? parts.join('; ') : null;
  }

  function conditionLinesOf(node) {
    return conditionalsOf(node).flatMap((conditional) => {
      const lines = [];
      const thenText = conditional.then === undefined ? null : consequenceTextOf(conditional.then);
      const condition = conditionTextOf(conditional.if) || NODE_CONDITION_UNSTATED;
      lines.push(`*When* ${condition}: ${thenText || NODE_CONDITION_UNSTATED}.`);
      if (conditional.else !== undefined) {
        lines.push(`*Otherwise:* ${consequenceTextOf(conditional.else) || NODE_CONDITION_UNSTATED}.`);
      }
      return lines;
    });
  }

  function listsKey(list, key) {
    return Array.isArray(list) && list.includes(key);
  }

  function combinedPartsOf(node, keywords) {
    return keywords.flatMap((keyword) => node[keyword] || []);
  }

  function mentionsKey(node, key) {
    if (!isSchemaObject(node)) return false;
    if (listsKey(node.required, key)) return true;
    if (isSchemaObject(node.not) && listsKey(node.not.required, key)) return true;
    if (isSchemaObject(node.properties) && Object.hasOwn(node.properties, key)) return true;
    const parts = combinedPartsOf(node, [...draft.conjunctionListKeywords, ...draft.alternativeListKeywords]);
    return parts.some((part) => mentionsKey(part, key));
  }

  function keyConsequenceTextOf(node, key) {
    const parts = [];
    if (listsKey(node.required, key)) parts.push('required');
    if (isSchemaObject(node.not) && listsKey(node.not.required, key)) parts.push('must not be set');
    const keySchema = isSchemaObject(node.properties) ? node.properties[key] : undefined;
    if (isSchemaObject(keySchema) && keySchema.const !== undefined) parts.push(`is ${jsonCode(keySchema.const)}`);
    else if (isSchemaObject(keySchema) && Array.isArray(keySchema.enum)) {
      parts.push(`is one of ${keySchema.enum.map(jsonCode).join(', ')}`);
    }
    for (const part of combinedPartsOf(node, draft.conjunctionListKeywords)) {
      if (mentionsKey(part, key)) parts.push(keyConsequenceTextOf(part, key));
    }
    const alternatives = combinedPartsOf(node, draft.alternativeListKeywords);
    if (alternatives.some((alternative) => mentionsKey(alternative, key))) {
      parts.push(alternatives.map((alternative) => (mentionsKey(alternative, key)
        ? keyConsequenceTextOf(alternative, key)
        : consequenceTextOf(alternative) || NODE_CONDITION_UNSTATED)).join(', or '));
    }
    return parts.join('; ');
  }

  function keyConditionLinesOf(parentNode, key) {
    return conditionalsOf(parentNode).flatMap((conditional) => {
      const thenMentions = mentionsKey(conditional.then, key);
      const elseMentions = mentionsKey(conditional.else, key);
      const condition = conditionTextOf(conditional.if) || NODE_CONDITION_UNSTATED;
      const lines = [];
      if (thenMentions) lines.push(`*When* ${condition}: ${keyConsequenceTextOf(conditional.then, key)}.`);
      if (elseMentions) {
        const label = thenMentions ? '*Otherwise:*' : `*Unless* ${condition}:`;
        lines.push(`${label} ${keyConsequenceTextOf(conditional.else, key)}.`);
      }
      return lines;
    });
  }

  function renderNode(node) {
    const forms = formsOf(node, new Set());
    const single = forms.length === 1;
    return {
      shape: forms.map(displayNameOf).join(' | '),
      accepts: single ? [] : forms.map(acceptedFormLine),
      tags: single ? tagsOf(forms[0].keywords) : [],
      conditions: conditionLinesOf(node),
    };
  }

  return { renderNode, keyConditionLinesOf, keyDependencyLinesOf, dependencyTextOf };
}

module.exports = { ANY_SHAPE, codeSpan, createSchemaRenderer };
