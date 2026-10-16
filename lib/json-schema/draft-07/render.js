const JSON_SCHEMA_DRAFT_07_RENDERER = {
  tagRenderers: [
    { keyword: 'items', label: 'Items', render: (value, helpers) => helpers.itemsTextOf(value) },
    { keyword: 'additionalItems', label: 'Further items', render: (value, helpers) => helpers.itemsTextOf(value) },
    { keyword: 'dependencies', label: 'Dependencies', render: (value, helpers) => helpers.neededKeysTextOf(value) },
  ],
};

module.exports = { JSON_SCHEMA_DRAFT_07_RENDERER };
