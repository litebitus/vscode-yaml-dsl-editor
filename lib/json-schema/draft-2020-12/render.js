const JSON_SCHEMA_DRAFT_2020_12_RENDERER = {
  tagRenderers: [
    { keyword: 'prefixItems', label: 'Items', render: (value, helpers) => `in order ${helpers.shapeListOf(value)}` },
    {
      keyword: 'items',
      label: 'Items',
      render: (value, helpers, keywords) => (keywords.prefixItems === undefined ? helpers.itemsTextOf(value) : null),
    },
    {
      keyword: 'items',
      label: 'Further items',
      render: (value, helpers, keywords) => (keywords.prefixItems === undefined ? null : helpers.itemsTextOf(value)),
    },
    { keyword: 'dependentRequired', label: 'Dependencies', render: (value, helpers) => helpers.neededKeysTextOf(value) },
  ],
};

module.exports = { JSON_SCHEMA_DRAFT_2020_12_RENDERER };
